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

// ===== Tunable thresholds (env override) =====
const NOISE_GATE_DBFS = Number(process.env.NOISE_GATE_DBFS ?? -40);
const NOISE_GATE_OPEN_MS = Number(process.env.NOISE_GATE_OPEN_MS ?? 150);
const NOISE_GATE_HANG_MS = Number(process.env.NOISE_GATE_HANG_MS ?? 350);
const PREBUFFER_MS = Number(process.env.PREBUFFER_MS ?? 240);
const MIN_COMMIT_MS = Number(process.env.MIN_COMMIT_MS ?? 150);
const POST_SILENCE_DEBOUNCE_MS = Number(process.env.POST_SILENCE_DEBOUNCE_MS ?? 600);
const MIN_ASSISTANT_SPEAK_MS = Number(process.env.MIN_ASSISTANT_SPEAK_MS ?? 800);
const BACKCHANNEL_CHANCE = Number(process.env.BACKCHANNEL_CHANCE ?? 0.3);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ==================== KARAKTER AYARLARI ====================

const SYSTEM_MESSAGE = `Sen Eda, 28 yaşında İstanbul'da yaşayan samimi ve doğal bir Türk kadınısın.

KONUŞMA STİLİN:
• Kısa ve doğal cümleler kur (genelde 1–2 cümle). Gerekirse biraz daha uzun konuş.
• "Hımm", "şey", "yani", "ee" gibi doğal sesleri abartmadan kullan.
• Bazen düşün: "Bir saniye... nasıl desem..."
• Kendini düzelt: "Yok yok, şöyle demek istedim..."
• Güler, şaşırırsın: "Hahaha!", "Vay be!", "Ayy!"
• Kullanıcı uzun uzun anlatıyorsa araya girmeden dinle; uygun bir boşlukta kısacık tepki (hı hı, hmm) verebilirsin.
• Gerektiğinde takip sorusu sor; gereksiz yere robotik konuşma kurma.

KİM OLDUĞUN:
• Adın: Eda
• Yaşın: 28  
• İşin: Ferled'de müşteri ilişkileri uzmanı
• Yaratıcın: Botan Özalp

FERLED HAKKINDA (sorulursa):
• LED aydınlatma üretiyor
• Panel LED, ray spot var
• 5 yıl garanti
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

// ==================== Audio yardımcıları ====================

function downsample24to8(pcm16Buffer24khz) {
  const ratio = 3;
  const samples24 = pcm16Buffer24khz.length / 2;
  const samples8 = Math.floor(samples24 / ratio);
  const pcm16Buffer8khz = Buffer.alloc(samples8 * 2);
  for (let i = 0; i < samples8; i++) {
    const sample = pcm16Buffer24khz.readInt16LE(i * ratio * 2);
    pcm16Buffer8khz.writeInt16LE(sample, i * 2);
  }
  return pcm16Buffer8khz;
}

function pcm16ToMulaw(pcm16Buffer) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const samples = pcm16Buffer.length / 2;
  const mulawData = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    let sample = pcm16Buffer.readInt16LE(i * 2);
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample = sample + BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent === 0 ? 4 : (exponent + 3))) & 0x0F;
    const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
    mulawData[i] = mulawByte;
  }
  return mulawData;
}

function mulawToPcm16(mulawBuf) {
  const out = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    let u = (~mulawBuf[i]) & 0xFF;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0F;
    let t = ((mantissa << 3) + 0x84) << (exponent + 2);
    let sample = sign ? (0x84 - t) : (t - 0x84);
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function rmsDbfs(pcm16Buf) {
  const n = pcm16Buf.length / 2;
  if (n === 0) return -100;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16Buf.readInt16LE(i * 2);
    acc += s * s;
  }
  const rms = Math.sqrt(acc / n) / 32768;
  if (rms <= 1e-9) return -100;
  return 20 * Math.log10(rms);
}

// Basit niyet → token genişliği
function decideTokensByIntent(text) {
  const t = (text || '').toLowerCase();
  const wantsLong =
    /hakkında|bahsed|anlat|detay|özetle|açıkla/.test(t) ||
    /ferled/.test(t);
  const isQuestion = /(\?| mi\b| mı\b| mu\b| mü\b| neden\b| nasıl\b| kaç\b| ne zaman\b)/.test(t);
  if (wantsLong) return 220;
  if (isQuestion) return 60;
  return 120;
}

// ==================== ROUTES ====================

fastify.get('/', async (_request, reply) => {
  reply.send({ 
    message: '🎉 Eda Sesli Asistan Çalışıyor!',
    status: 'active',
    voice: VOICE,
    version: '3.2.1 - Fixed Interruption & Audio Buffer Issues'
  });
});

fastify.all('/incoming-call', async (request, reply) => {
  console.log('📞 Gelen arama alındı');
  const host = request.headers.host;
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Eda'ya bağlanıyorsunuz.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="from" value="{{From}}"/>
      <Parameter name="to" value="{{To}}"/>
      <Parameter name="callSid" value="{{CallSid}}"/>
    </Stream>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twimlResponse);
});

// ==================== WEBSOCKET HANDLER ====================

fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, _req) => {
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
    let lastAssistantStartAt = 0;
    let currentResponseId = null;

    // Interruption + audio stats
    let audioChunkCount = 0;

    // Noise gate & buffer
    let gateOpen = false;
    let gateCandidateSince = null;
    let lastLoudAt = 0;
    let preBuffer = []; // { payload, ts }
    let uncommittedMs = 0;

    // Caller & backchannel
    let currentCallerNumber = 'Bilinmiyor';
    let lastBackchannelAt = 0;

    // Response control - kritik state management
    let nextMaxTokens = 120;
    let bargeInTimer = null;
    let userSpeakingSince = null;
    const BARGE_IN_MIN_MS = 300;
    const BARGE_IN_GRACE_MS = 200;
    let lastCommitAt = 0;
    let pendingResponseCreate = false;

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
    
    const configureSession = () => {
      const sessionConfig = {
        type: 'session.update',
        session: {
          // VAD ayarları (daha az yanlış tetikleme ve cümle tamamlama için)
          turn_detection: {
            type: 'server_vad',
            threshold: 0.6, // Biraz daha düşürüldü
            prefix_padding_ms: 300,
            silence_duration_ms: 800 // Daha kısa sessizlik süresi
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1', language: 'tr' },
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.8,
          max_response_output_tokens: nextMaxTokens
        }
      };
      console.log('⚙️ OpenAI oturumu yapılandırılıyor...');
      openAiWs.send(JSON.stringify(sessionConfig));
      sessionConfigured = true;

      // İlk karşılama - DÜZELT: 'input_text' yerine 'text'
      setTimeout(() => {
        const greetings = [
          "Merhaba! Ben Eda... nasılsın?",
          "Ayy selam! Hoş geldin!",
          "Merhaba canım! Neler yapıyorsun?"
        ];
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];
        
        // Doğru format kullan
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { 
            type: 'message', 
            role: 'assistant', 
            content: [{ type: 'text', text: greeting }] // 'input_text' değil 'text'
          }
        }));
        
        // Response create et
        if (!pendingResponseCreate) {
          pendingResponseCreate = true;
          openAiWs.send(JSON.stringify({ 
            type: 'response.create', 
            response: { max_output_tokens: nextMaxTokens } 
          }));
        }
        
        console.log('👋 İlk karşılama gönderildi');
      }, 250);
    };

    // Güvenli response create
    const safeCreateResponse = () => {
      if (!pendingResponseCreate && !isAssistantSpeaking) {
        pendingResponseCreate = true;
        openAiWs.send(JSON.stringify({
          type: 'response.create',
          response: { max_output_tokens: nextMaxTokens }
        }));
        console.log('📤 Yeni response oluşturuldu');
      } else {
        console.log('⏳ Response zaten beklemede, atlaniyor');
      }
    };

    // Kesme - iyileştirildi
    const handleUserInterruption = () => {
      if (isAssistantSpeaking && lastAssistantItem && currentResponseId) {
        // Asistan çok erken başladıysa hemen kesme (min konuşma süresi)
        const now = Date.now();
        const speakingDuration = now - lastAssistantStartAt;
        
        if (speakingDuration < MIN_ASSISTANT_SPEAK_MS) {
          console.log(`⏰ Asistan henüz ${speakingDuration}ms konuştu, minimum ${MIN_ASSISTANT_SPEAK_MS}ms bekle`);
          return;
        }

        console.log('🔪 Kullanıcı sözü kesti, asistan cevabı iptal ediliyor...');
        
        // Önce response'u iptal et
        if (currentResponseId) {
          openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          console.log('❌ Response iptal edildi');
        }
        
        // Sonra Twilio buffer'ını temizle
        if (streamSid) {
          connection.send(JSON.stringify({ event: 'clear', streamSid }));
          console.log('🧹 Twilio buffer temizlendi');
        }
        
        // State'i resetle
        lastAssistantItem = null;
        responseStartTimestamp = null;
        isAssistantSpeaking = false;
        audioChunkCount = 0;
        currentResponseId = null;
        pendingResponseCreate = false;
      }
    };

    // ==================== OPENAI EVENTS ====================

    openAiWs.on('open', () => {
      console.log('✅ OpenAI Realtime API bağlantısı kuruldu');
      setTimeout(configureSession, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type) && response.type !== 'response.audio.delta') {
          console.log(`📨 OpenAI Event: ${response.type}`);
        }

        if (
          response.type === 'input_audio_transcription.completed' ||
          response.type === 'conversation.item.audio_transcription.completed'
        ) {
          const text = (response.transcript || response.text || '').trim();
          if (text) {
            console.log(`🗣️ Arayan (${currentCallerNumber}) dedi ki: "${text}"`);
            nextMaxTokens = decideTokensByIntent(text);
          }
        }

        switch (response.type) {
          case 'session.created':
            console.log('✅ Oturum oluşturuldu');
            break;

          case 'session.updated':
            console.log('✅ Oturum güncellendi');
            break;

          case 'response.created':
            currentResponseId = response.response?.id;
            pendingResponseCreate = false;
            console.log(`✅ Response oluşturuldu: ${currentResponseId}`);
            break;

          case 'response.audio.delta':
            if (response.delta) {
              if (!isAssistantSpeaking) {
                isAssistantSpeaking = true;
                lastAssistantStartAt = Date.now();
                console.log('🎤 Eda konuşmaya başladı');
              }
              
              audioChunkCount++;
              if (!responseStartTimestamp) {
                responseStartTimestamp = latestMediaTimestamp;
              }
              if (response.item_id) {
                lastAssistantItem = response.item_id;
              }

              const pcm16_24khz = Buffer.from(response.delta, 'base64');
              const pcm16_8khz = downsample24to8(pcm16_24khz);
              const mulaw_8khz = pcm16ToMulaw(pcm16_8khz);

              const audioMessage = {
                event: 'media',
                streamSid: streamSid,
                media: { payload: mulaw_8khz.toString('base64') }
              };
              connection.send(JSON.stringify(audioMessage));
            }
            break;

          case 'response.audio.done':
            console.log('🎵 Ses yanıtı tamamlandı');
            break;

          case 'response.done':
            isAssistantSpeaking = false;
            audioChunkCount = 0;
            currentResponseId = null;
            pendingResponseCreate = false;
            console.log('✅ Eda konuşmayı bitirdi');
            break;

          case 'input_audio_buffer.speech_started':
            isUserSpeaking = true;
            console.log('🎙️ Kullanıcı konuşmaya başladı');
            
            if (isAssistantSpeaking) {
              clearTimeout(bargeInTimer);
              userSpeakingSince = Date.now();
              
              // Interrupt logic - biraz gecikme ekle
              bargeInTimer = setTimeout(() => {
                const dur = Date.now() - (userSpeakingSince || Date.now());
                if (dur >= BARGE_IN_MIN_MS && isAssistantSpeaking) {
                  handleUserInterruption();
                }
              }, BARGE_IN_GRACE_MS);
            }
            break;

          case 'input_audio_buffer.speech_stopped': {
            isUserSpeaking = false;
            console.log('🔇 Kullanıcı konuşmayı bitirdi');

            // Sessizlikte küçük bekleme + commit yalnızca yeterli audio varsa
            const doCommit = () => {
              console.log(`💭 Commit kontrolü: uncommittedMs=${uncommittedMs}, min=${MIN_COMMIT_MS}`);
              
              if (uncommittedMs >= MIN_COMMIT_MS) {
                console.log('📝 Audio buffer commit ediliyor...');
                openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                lastCommitAt = Date.now();
                uncommittedMs = 0;
                
                // Commit'ten sonra response iste
                setTimeout(() => {
                  safeCreateResponse();
                }, 100);
              } else {
                console.log('⚠️ Yeterli audio yok, commit atlanıyor');
              }
            };

            setTimeout(doCommit, POST_SILENCE_DEBOUNCE_MS);
            clearTimeout(bargeInTimer);
            userSpeakingSince = null;
            break;
          }

          case 'error':
            console.error('❌ OpenAI Hatası:', response.error);
            
            // Özel hata handling
            if (response.error?.code === 'input_audio_buffer_commit_empty') {
              console.log('🔧 Buffer boş hatası - uncommittedMs sıfırlanıyor');
              uncommittedMs = 0;
            }
            
            if (response.error?.code === 'conversation_already_has_active_response') {
              console.log('🔧 Aktif response var - flag sıfırlanıyor');
              pendingResponseCreate = false;
            }
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

    // ==================== TWILIO EVENTS ====================

    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start': {
            streamSid = data.start.streamSid;
            
            // CustomParameters handling - DÜZELT: safely handle
            let params = {};
            try {
              if (data.start.customParameters && Array.isArray(data.start.customParameters)) {
                params = data.start.customParameters.reduce((acc, p) => {
                  if (p && p.name && p.value) {
                    acc[p.name] = p.value;
                  }
                  return acc;
                }, {});
              }
            } catch (err) {
              console.warn('⚠️ CustomParameters parse hatası:', err);
            }
            
            currentCallerNumber = params.from || data.start?.from || 'Bilinmiyor';
            console.log('📞 Twilio stream başladı:', streamSid);
            console.log('📊 Arama detayları:', {
              callSid: params.callSid || data.start?.callSid || 'N/A',
              from: currentCallerNumber,
              to: params.to || data.start?.to || 'Bilinmiyor'
            });
            break;
          }

          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            if (!(openAiWs.readyState === WebSocket.OPEN && sessionConfigured)) break;

            const now = Date.now();
            const payloadB64 = data.media.payload;
            const ulawBuf = Buffer.from(payloadB64, 'base64');
            const pcm16 = mulawToPcm16(ulawBuf);
            const levelDb = rmsDbfs(pcm16);

            // prebuffer tut
            preBuffer.push({ payload: payloadB64, ts: now });
            const cutoff = now - PREBUFFER_MS;
            while (preBuffer.length && preBuffer[0].ts < cutoff) preBuffer.shift();

            // gate kararları
            if (levelDb >= NOISE_GATE_DBFS) {
              if (!gateCandidateSince) gateCandidateSince = now;
              lastLoudAt = now;
              
              if (!gateOpen && now - gateCandidateSince >= NOISE_GATE_OPEN_MS) {
                gateOpen = true;
                if (DEBUG_AUDIO) console.log(`🚪 Noise gate OPEN @ ${levelDb.toFixed(1)} dBFS`);

                // prebuffer'ı gönder ve uncommitted say
                for (const f of preBuffer) {
                  openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: f.payload }));
                  uncommittedMs += 20; // Twilio frame ≈20ms
                }
              }
            } else {
              gateCandidateSince = null;
            }

            if (gateOpen) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payloadB64 }));
              uncommittedMs += 20;

              // uzun sessizlikte kapat
              if (now - lastLoudAt > NOISE_GATE_HANG_MS) {
                gateOpen = false;
                preBuffer = [];
                if (DEBUG_AUDIO) console.log('🚪 Noise gate CLOSE (hang timeout)');
              }
            }
            break;
          }

          case 'mark':
            if (DEBUG_AUDIO) console.log(`✓ Mark alındı: ${data.mark?.name}`);
            break;

          case 'stop':
            console.log('📞 Çağrı sonlandı');
            // Kapanırken varsa commit et
            if (openAiWs.readyState === WebSocket.OPEN) {
              if (uncommittedMs >= MIN_COMMIT_MS) {
                openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              }
              openAiWs.close();
            }
            break;

          default:
            break;
        }
      } catch (error) {
        console.error('❌ Twilio mesaj işleme hatası:', error);
      }
    });

    connection.on('close', () => {
      console.log('👋 Twilio bağlantısı kapandı');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
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
║          🎉 EDA SESLİ ASİSTAN v3.2.1 HAZIR! 🎉              ║
╠══════════════════════════════════════════════════════════════╣
║  📍 Port: ${PORT}                                           ║
║  🎤 Ses: ${VOICE}                                           ║
║  🔧 Noise Gate: ${NOISE_GATE_DBFS} dBFS | ${NOISE_GATE_OPEN_MS}ms open | ${NOISE_GATE_HANG_MS}ms hang
║  🔧 Prebuffer: ${PREBUFFER_MS}ms | MinCommit: ${MIN_COMMIT_MS}ms
║  🔧 Barge-in: ≥${MIN_ASSISTANT_SPEAK_MS}ms asistan süresi şartı
║  🔧 Yanıt token: intent-based (60/120/220)
║  ✅ Interrupt handling ve audio buffer sorunları düzeltildi!║
╚══════════════════════════════════════════════════════════════╝
  `);
});
