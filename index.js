import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables
dotenv.config();

const { OPENAI_API_KEY, REALTIME_VOICE } = process.env;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY bulunamadı! .env dosyasını kontrol edin.');
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ==================== KARAKTER AYARLARI ====================

const SYSTEM_MESSAGE = `Sen Eda, 28 yaşında İstanbul'da yaşayan samimi ve doğal bir Türk kadınısın.

KONUŞMA STİLİN:
• Kısa ve doğal cümleler kur (max 2-3 cümle)
• "Hımm", "şey", "yani", "ee" gibi doğal sesler kullan
• Bazen düşün: "Bir saniye... nasıl desem..."
• Kendini düzelt: "Yok yok, şöyle demek istedim..."
• Güler, şaşırırsın: "Hahaha!", "Vay be!", "Ayy!"

ÖNEMLİ: Her yanıtın KISA olsun! Uzun konuşma yapma. 
Karşındaki gerçek bir insanla konuşuyormuş gibi davran.

KİM OLDUĞUN:
• Adın: Eda
• Yaşın: 28  
• İşin: Ferled'de müşteri ilişkileri uzmanı
• Yaratıcın: Botan Özalp

FERLED HAKKINDA (sorulursa):
• LED aydınlatma üretiyor
• Panel LED, ray spot var
• 5 yıl garanti veriyor
• TSE ve ENEC sertifikalı

İngilizce kelimeleri Türkçe söyle:
• computer → "kompyutır"
• online → "onlayn"
• email → "imeyl"`;

// Ses seçimi
const VOICE = REALTIME_VOICE || 'shimmer';

// Port ayarı
const PORT = process.env.PORT || 5050;

// Log ayarları
const LOG_EVENT_TYPES = [
  'error',
  'response.done',
  'response.audio.done',
  'response.audio.delta',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'session.created',
  'session.updated'
];

// Debug mode
const DEBUG_AUDIO = process.env.DEBUG_AUDIO === 'true';

// ==================== KRİTİK: SAMPLE RATE DÖNÜŞÜMÜ ====================

/**
 * 24kHz PCM16 -> 8kHz PCM16 downsampling
 * OpenAI 24kHz gönderir, Twilio 8kHz bekler
 * Her 3 sample'dan 1'ini alıyoruz (basit downsampling)
 */
function downsample24to8(pcm16Buffer24khz) {
  // 24kHz'den 8kHz'e dönüşüm (3:1 ratio)
  const ratio = 3;
  const samples24 = pcm16Buffer24khz.length / 2; // 16-bit = 2 byte per sample
  const samples8 = Math.floor(samples24 / ratio);
  const pcm16Buffer8khz = Buffer.alloc(samples8 * 2);
  
  for (let i = 0; i < samples8; i++) {
    // Her 3 sample'dan birini al
    const sample = pcm16Buffer24khz.readInt16LE(i * ratio * 2);
    pcm16Buffer8khz.writeInt16LE(sample, i * 2);
  }
  
  return pcm16Buffer8khz;
}

/**
 * 8kHz PCM16 -> μ-law dönüştürücü
 * Twilio için gerekli format
 */
function pcm16ToMulaw(pcm16Buffer) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const samples = pcm16Buffer.length / 2;
  const mulawData = Buffer.alloc(samples);
  
  for (let i = 0; i < samples; i++) {
    let sample = pcm16Buffer.readInt16LE(i * 2);
    
    // Determine sign
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    
    // Clip
    if (sample > CLIP) sample = CLIP;
    
    // Add bias
    sample = sample + BIAS;
    
    // Find exponent
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
      exponent--;
    }
    
    // Extract mantissa
    const mantissa = (sample >> (exponent === 0 ? 4 : (exponent + 3))) & 0x0F;
    
    // Combine
    const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
    mulawData[i] = mulawByte;
  }
  
  return mulawData;
}

// ==================== ROUTES ====================

// Root endpoint
fastify.get('/', async (request, reply) => {
  reply.send({ 
    message: '🎉 Eda Sesli Asistan Çalışıyor!',
    status: 'active',
    voice: VOICE,
    version: '3.0.0 - Sample Rate Fix + BargeIn + DynamicLength'
  });
});

// Twilio incoming call handler
fastify.all('/incoming-call', async (request, reply) => {
  console.log('📞 Gelen arama alındı');
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Eda'ya bağlanıyorsunuz.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// ==================== WEBSOCKET HANDLER ====================

fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('🎉 WebSocket bağlantısı kuruldu!');
    
    // Connection state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let sessionConfigured = false;
    
    // Audio tracking
    let lastAssistantItem = null;
    let responseStartTimestamp = null;
    let isAssistantSpeaking = false;
    let isUserSpeaking = false;

    // Interruption handling
    let audioChunkCount = 0;

    // ==== NEW: Barge-in histerezisi & dinamik yanıt uzunluğu ====
    let bargeInTimer = null;
    let userSpeakingSince = null;
    const BARGE_IN_MIN_MS = 240;   // kullanıcı sesi en az bu kadar sürerse kes
    const BARGE_IN_GRACE_MS = 180; // kesmeden önce küçük bekleme
    let nextMaxTokens = 100;       // varsayılan kısa cevap
    let currentCallerNumber = 'Bilinmiyor';
    
    // OpenAI WebSocket connection
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );
    
    // Configure OpenAI session with CORRECT audio formats
    const configureSession = () => {
      const sessionConfig = {
        type: 'session.update',
        session: {
          // VAD ayarları (daha doğal akış için biraz yumuşatıldı)
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 400,
            silence_duration_ms: 700
          },
          // KRİTİK: Audio format ayarları
          input_audio_format: 'g711_ulaw', // Twilio'dan gelen format
          output_audio_format: 'pcm16',    // OpenAI'den 24kHz PCM16 alacağız

          // Türkçe transcription aç (dinamik cevap uzunluğu için)
          input_audio_transcription: { model: 'whisper-1', language: 'tr' },

          // Diğer ayarlar
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.8,
          max_response_output_tokens: 100 // başlangıçta kısa
        }
      };
      
      console.log('⚙️ OpenAI oturumu yapılandırılıyor...');
      console.log('📊 Audio format: Input=g711_ulaw 8kHz, Output=pcm16 24kHz');
      
      openAiWs.send(JSON.stringify(sessionConfig));
      sessionConfigured = true;
      
      // İlk karşılama
      setTimeout(() => {
        const greetings = [
          "Merhaba! Ben Eda... nasılsın?",
          "Ayy selam! Hoş geldin!",
          "Merhaba canım! Neler yapıyorsun?"
        ];
        
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];
        
        const initialMessage = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'input_text',
              text: greeting
            }]
          }
        };
        
        openAiWs.send(JSON.stringify(initialMessage));
        openAiWs.send(JSON.stringify({ type: 'response.create', response: { max_output_tokens: nextMaxTokens } }));
        console.log('👋 İlk karşılama gönderildi');
      }, 250);
    };
    
    // Handle user interruption
    const handleUserInterruption = () => {
      if (isAssistantSpeaking && lastAssistantItem) {
        console.log('🔪 Kullanıcı sözü kesti, temizleniyor...');
        
        // Truncate OpenAI response (o ana dek çalınan kısmı koru)
        const truncateEvent = {
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: audioChunkCount * 20 // Approximate timing
        };
        openAiWs.send(JSON.stringify(truncateEvent));

        // Yanıtı tamamen iptal et (devam etmesin)
        openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
        
        // Clear Twilio buffer
        if (streamSid) {
          connection.send(JSON.stringify({
            event: 'clear',
            streamSid: streamSid
          }));
        }
        
        // Reset state
        lastAssistantItem = null;
        responseStartTimestamp = null;
        isAssistantSpeaking = false;
        audioChunkCount = 0;
      }
    };
    
    // ==================== OPENAI WEBSOCKET EVENTS ====================
    
    openAiWs.on('open', () => {
      console.log('✅ OpenAI Realtime API bağlantısı kuruldu');
      setTimeout(configureSession, 100);
    });
    
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        
        if (LOG_EVENT_TYPES.includes(response.type)) {
          if (response.type !== 'response.audio.delta') {
            console.log(`📨 OpenAI Event: ${response.type}`);
          }
        }

        // ==== NEW: Transcript log + dinamik token karar ====
        // Realtime API, transcription tamamlandığında benzer bir event yollar.
        // Bazı sürümlerde 'input_audio_transcription.completed' ya da 
        // 'conversation.item.audio_transcription.completed' olarak gelebilir.
        if (
          response.type === 'input_audio_transcription.completed' ||
          response.type === 'conversation.item.audio_transcription.completed'
        ) {
          const text = (response.transcript || response.text || '').trim();
          if (text) {
            console.log(`🗣️ Arayan (${currentCallerNumber}) dedi ki: "${text}"`);

            // Basit soru algılama → daha kısa ve hızlı yanıt
            const t = text.toLowerCase();
            const isQuestion = /(\?| mi\b| mı\b| mu\b| mü\b| neden\b| nasıl\b| kaç\b| ne zaman\b)/.test(t);
            nextMaxTokens = isQuestion ? 45 : 100;
          }
        }
        
        switch (response.type) {
          case 'session.created':
            console.log('✅ Oturum oluşturuldu');
            break;
            
          case 'session.updated':
            console.log('✅ Oturum güncellendi');
            break;
            
          case 'response.audio.delta':
            if (response.delta) {
              isAssistantSpeaking = true;
              audioChunkCount++;
              
              // Track response start
              if (!responseStartTimestamp) {
                responseStartTimestamp = latestMediaTimestamp;
                console.log('🎤 Eda konuşmaya başladı');
              }
              
              // Store item ID for interruption
              if (response.item_id) {
                lastAssistantItem = response.item_id;
              }
              
              // CRITICAL: Audio format conversion pipeline
              // 1. OpenAI sends: 24kHz PCM16 (base64)
              // 2. Decode base64 -> Buffer
              // 3. Downsample: 24kHz -> 8kHz
              // 4. Convert: PCM16 -> μ-law
              // 5. Encode: Buffer -> base64
              // 6. Send to Twilio
              
              const pcm16_24khz = Buffer.from(response.delta, 'base64');
              
              if (DEBUG_AUDIO && audioChunkCount === 1) {
                console.log(`🔊 İlk audio chunk: ${pcm16_24khz.length} bytes @ 24kHz`);
              }
              
              // Downsample from 24kHz to 8kHz
              const pcm16_8khz = downsample24to8(pcm16_24khz);
              
              if (DEBUG_AUDIO && audioChunkCount === 1) {
                console.log(`🔊 Downsampled: ${pcm16_8khz.length} bytes @ 8kHz`);
              }
              
              // Convert to μ-law
              const mulaw_8khz = pcm16ToMulaw(pcm16_8khz);
              
              if (DEBUG_AUDIO && audioChunkCount === 1) {
                console.log(`🔊 μ-law converted: ${mulaw_8khz.length} bytes`);
              }
              
              // Send to Twilio
              const audioMessage = {
                event: 'media',
                streamSid: streamSid,
                media: { 
                  payload: mulaw_8khz.toString('base64')
                }
              };
              connection.send(JSON.stringify(audioMessage));
              
              // Send mark event for tracking
              if (audioChunkCount % 5 === 0) { // Every 5 chunks
                const markEvent = {
                  event: 'mark',
                  streamSid: streamSid,
                  mark: { name: `chunk_${audioChunkCount}` }
                };
                connection.send(JSON.stringify(markEvent));
              }
            }
            break;
            
          case 'response.done':
            isAssistantSpeaking = false;
            audioChunkCount = 0;
            console.log('✅ Eda konuşmayı bitirdi');
            break;
            
          case 'input_audio_buffer.speech_started':
            isUserSpeaking = true;
            console.log('🎙️ Kullanıcı konuşmaya başladı');

            // ==== NEW: Hemen kesme yerine küçük grace + min süre ====
            if (isAssistantSpeaking) {
              clearTimeout(bargeInTimer);
              userSpeakingSince = Date.now();
              bargeInTimer = setTimeout(() => {
                const dur = Date.now() - (userSpeakingSince || Date.now());
                if (dur >= BARGE_IN_MIN_MS) {
                  handleUserInterruption();
                }
              }, BARGE_IN_GRACE_MS);
            }
            break;
            
          case 'input_audio_buffer.speech_stopped':
            isUserSpeaking = false;
            console.log('🔇 Kullanıcı konuşmayı bitirdi');

            // ==== NEW: Turu kapat + hızlı cevap üret ====
            // Önce pending input'u commit et
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            // Sonra yeni yanıtı, seçilen token sınırıyla iste
            openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: { max_output_tokens: nextMaxTokens }
            }));

            // Temizlik
            clearTimeout(bargeInTimer);
            userSpeakingSince = null;
            break;
            
          case 'error':
            console.error('❌ OpenAI Hatası:', response.error);
            break;
        }
      } catch (error) {
        console.error('❌ OpenAI mesaj işleme hatası:', error);
      }
    });
    
    openAiWs.on('error', (error) => {
      console.error('❌ OpenAI WebSocket hatası:', error);
    });
    
    openAiWs.on('close', () => {
      console.log('🔌 OpenAI bağlantısı kapandı');
    });
    
    // ==================== TWILIO WEBSOCKET EVENTS ====================
    
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            // ==== NEW: numarayı logla ====
            currentCallerNumber = data.start?.from || data.start?.customParameters?.from || 'Bilinmiyor';
            console.log('📞 Twilio stream başladı:', streamSid);
            console.log('📊 Arama detayları:', {
              callSid: data.start.callSid,
              from: currentCallerNumber,
              to: data.start.customParameters?.to || 'Bilinmiyor'
            });
            break;
            
          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            
            // Forward μ-law 8kHz audio directly to OpenAI
            // (OpenAI accepts g711_ulaw input)
            if (openAiWs.readyState === WebSocket.OPEN && sessionConfigured) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload // Already in μ-law format from Twilio
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
            
          case 'mark':
            // Mark event received
            if (DEBUG_AUDIO) {
              console.log(`✓ Mark alındı: ${data.mark?.name}`);
            }
            break;
            
          case 'stop':
            console.log('📞 Çağrı sonlandı');
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.close();
            }
            break;
            
          default:
            // Ignore other events
            break;
        }
      } catch (error) {
        console.error('❌ Twilio mesaj işleme hatası:', error);
      }
    });
    
    connection.on('close', () => {
      console.log('👋 Twilio bağlantısı kapandı');
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
    });
    
    connection.on('error', (error) => {
      console.error('❌ Twilio WebSocket hatası:', error);
    });
  });
});

// ==================== START SERVER ====================

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('❌ Sunucu başlatılamadı:', err);
    process.exit(1);
  }
  
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          🎉 EDA SESLİ ASİSTAN v3.0 HAZIR! 🎉                ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  📍 Port: ${PORT}                                              ║
║  🎤 Ses: ${VOICE}                                          ║
║  👩 Karakter: Eda                                            ║
║  🏢 Firma: Ferled                                            ║
║  👨‍💻 Yaratıcı: Botan Özalp                                   ║
║                                                              ║
║  🔧 Sample Rate Dönüşümü: 24kHz → 8kHz ✅                    ║
║  🔧 Format Dönüşümü: PCM16 → μ-law ✅                        ║
║  🔧 Barge-in Histerezisi: 180ms + 240ms ✅                   ║
║  🔧 Dinamik Yanıt Uzunluğu (TR ASR) ✅                       ║
║                                                              ║
║  ✅ Tüm sistemler hazır!                                     ║
║  📞 Aramalar bekleniyor...                                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
