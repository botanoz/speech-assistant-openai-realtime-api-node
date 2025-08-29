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

// Log ayarları - sadece önemli eventler
const LOG_EVENT_TYPES = [
  'error',
  'response.done',
  'response.audio.done',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'session.created'
];

// ==================== SES DÖNÜŞÜM FONKSİYONLARI ====================

// Basitleştirilmiş PCM16 -> μ-law dönüştürücü
function pcm16ToUlaw(pcm16Buffer) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const samples = pcm16Buffer.length / 2;
  const ulawData = Buffer.alloc(samples);
  
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
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    
    // Extract mantissa
    const mantissa = (sample >> (exponent === 0 ? 4 : (exponent + 3))) & 0x0F;
    
    // Combine
    const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
    ulawData[i] = ulawByte;
  }
  
  return ulawData;
}

// ==================== ROUTES ====================

// Root endpoint
fastify.get('/', async (request, reply) => {
  reply.send({ 
    message: '🎉 Eda Sesli Asistan Çalışıyor!',
    status: 'active',
    voice: VOICE
  });
});

// Twilio incoming call handler
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Eda'ya bağlanıyorsunuz, lütfen bekleyin.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// ==================== WEBSOCKET HANDLER ====================

fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('📞 Yeni çağrı bağlantısı kuruldu!');
    
    // Connection state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let sessionConfigured = false;
    
    // Audio state tracking
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestamp = null;
    let isAssistantSpeaking = false;
    let isUserSpeaking = false;
    
    // Interruption handling
    let interruptionStartTime = null;
    const MIN_INTERRUPTION_TIME = 500; // 500ms minimum kesinti süresi
    
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
    
    // Send mark event to track audio playback
    const sendMark = () => {
      if (streamSid) {
        const markEvent = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'audio_chunk' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('audio_chunk');
      }
    };
    
    // Clear Twilio buffer
    const clearTwilioBuffer = () => {
      if (streamSid) {
        connection.send(JSON.stringify({
          event: 'clear',
          streamSid: streamSid
        }));
        markQueue = [];
      }
    };
    
    // Configure OpenAI session
    const configureSession = () => {
      const sessionConfig = {
        type: 'session.update',
        session: {
          // Optimize edilmiş VAD ayarları
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700
          },
          // Ses formatları - kritik!
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'pcm16',
          // Ses ve model ayarları
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.8,
          max_response_output_tokens: 100
        }
      };
      
      console.log('⚙️ OpenAI oturumu yapılandırılıyor...');
      openAiWs.send(JSON.stringify(sessionConfig));
      sessionConfigured = true;
      
      // İlk karşılama mesajını gönder
      setTimeout(() => {
        const greetings = [
          "Merhaba! Ben Eda... ee, nasılsın?",
          "Ayy selam! Ben Eda, hoş geldin!",
          "Merhaba canım! Nasıl gidiyor?"
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
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
      }, 250);
    };
    
    // Handle user interruption
    const handleUserInterruption = () => {
      if (isAssistantSpeaking && lastAssistantItem) {
        const now = Date.now();
        
        // Minimum kesinti süresini kontrol et
        if (!interruptionStartTime) {
          interruptionStartTime = now;
          return;
        }
        
        if (now - interruptionStartTime >= MIN_INTERRUPTION_TIME) {
          console.log('🔪 Kullanıcı sözü kesti');
          
          // OpenAI'ye kesinti bildir
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: Math.floor((latestMediaTimestamp - responseStartTimestamp) * 0.8)
          };
          openAiWs.send(JSON.stringify(truncateEvent));
          
          // Twilio buffer'ı temizle
          clearTwilioBuffer();
          
          // State'i sıfırla
          lastAssistantItem = null;
          responseStartTimestamp = null;
          isAssistantSpeaking = false;
          interruptionStartTime = null;
        }
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
          console.log(`📨 Event: ${response.type}`);
        }
        
        switch (response.type) {
          case 'session.created':
            console.log('✅ Oturum oluşturuldu');
            break;
            
          case 'response.audio.delta':
            if (response.delta) {
              isAssistantSpeaking = true;
              
              // Track response start time
              if (!responseStartTimestamp) {
                responseStartTimestamp = latestMediaTimestamp;
                console.log('🎤 Eda konuşmaya başladı');
              }
              
              // Store item ID for interruption handling
              if (response.item_id) {
                lastAssistantItem = response.item_id;
              }
              
              // Convert PCM16 to μ-law
              const pcm16Buffer = Buffer.from(response.delta, 'base64');
              const ulawBuffer = pcm16ToUlaw(pcm16Buffer);
              const ulawBase64 = ulawBuffer.toString('base64');
              
              // Send audio to Twilio
              const audioMessage = {
                event: 'media',
                streamSid: streamSid,
                media: { payload: ulawBase64 }
              };
              connection.send(JSON.stringify(audioMessage));
              
              // Send mark for tracking
              sendMark();
            }
            break;
            
          case 'response.done':
            isAssistantSpeaking = false;
            console.log('✅ Eda konuşmayı bitirdi');
            break;
            
          case 'input_audio_buffer.speech_started':
            isUserSpeaking = true;
            console.log('🎙️ Kullanıcı konuşmaya başladı');
            handleUserInterruption();
            break;
            
          case 'input_audio_buffer.speech_stopped':
            isUserSpeaking = false;
            interruptionStartTime = null;
            console.log('🔇 Kullanıcı konuşmayı bitirdi');
            break;
            
          case 'error':
            console.error('❌ OpenAI Hatası:', response.error);
            break;
        }
      } catch (error) {
        console.error('❌ OpenAI mesaj işleme hatası:', error, 'Data:', data.toString());
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
            console.log('📞 Twilio stream başladı:', streamSid);
            console.log('📊 Çağrı detayları:', {
              callSid: data.start.callSid,
              accountSid: data.start.accountSid,
              from: data.start.customParameters?.from || 'Bilinmiyor',
              to: data.start.customParameters?.to || 'Bilinmiyor'
            });
            break;
            
          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            
            // Forward audio to OpenAI (already in μ-law format)
            if (openAiWs.readyState === WebSocket.OPEN && sessionConfigured) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
            
          case 'mark':
            // Remove processed mark from queue
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
            
          case 'stop':
            console.log('📞 Çağrı sonlandı');
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.close();
            }
            break;
            
          default:
            // console.log('📨 Diğer Twilio event:', data.event);
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
╔══════════════════════════════════════════════════╗
║     🎉 EDA SESLİ ASİSTAN SUNUCUSU HAZIR! 🎉      ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  📍 Port: ${PORT}                                  ║
║  🎤 Ses: ${VOICE}                              ║
║  👩 Karakter: Eda                                ║
║  🏢 Firma: Ferled                                ║
║  👨‍💻 Yaratıcı: Botan Özalp                       ║
║                                                  ║
║  ✅ Tüm sistemler hazır!                         ║
║  📞 Aramalar bekleniyor...                       ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
