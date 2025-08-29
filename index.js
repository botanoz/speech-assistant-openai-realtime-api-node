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

// ===== Noise gate ayarları (env ile override edilebilir) =====
const NOISE_GATE_DBFS = Number(process.env.NOISE_GATE_DBFS ?? -45);   // dBFS eşiği
const NOISE_GATE_OPEN_MS = Number(process.env.NOISE_GATE_OPEN_MS ?? 120); // kapının açılması için min süre
const NOISE_GATE_HANG_MS = Number(process.env.NOISE_GATE_HANG_MS ?? 300); // kapanmadan önce bekleme
const PREBUFFER_MS = Number(process.env.PREBUFFER_MS ?? 240);            // kapı açıldığında geriye dönük gönderilecek süre

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

// ==================== Audio yardımcıları ====================

/**
 * 24kHz PCM16 -> 8kHz PCM16 downsampling (basit 3:1)
 */
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

/**
 * 8kHz PCM16 -> μ-law
 */
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

/**
 * μ-law -> 8kHz PCM16 (noise gate için seviye ölçümü)
 */
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

/**
 * PCM16 RMS dBFS hesapla
 */
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

// ==================== ROUTES ====================

fastify.get('/', async (_request, reply) => {
  reply.send({ 
    message: '🎉 Eda Sesli Asistan Çalışıyor!',
    status: 'active',
    voice: VOICE,
    version: '3.1.0 - NoiseGate+BargeIn+DynamicLength'
  });
});

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
    
    // Interruption handling
    let audioChunkCount = 0;

    // ===== NEW: Noise gate & prebuffer durumu =====
    let gateOpen = false;
    let gateCandidateSince = null;
    let lastLoudAt = 0;
    let gateOpenedAt = 0;
    let preBuffer = []; // { payload, ts }
    let currentCallerNumber = 'Bilinmiyor';

    // ===== NEW: Yanıt uzunluğu ve debounce =====
    let nextMaxTokens = 120;  // default kısa ama cümle tamamlayıcı
    let bargeInTimer = null;
    let userSpeakingSince = null;
    const BARGE_IN_MIN_MS = 240;
    const BARGE_IN_GRACE_MS = 180;
    let lastCommitAt = 0;     // speech_stopped debounce

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
    
    // OpenAI session config
    const configureSession = () => {
      const sessionConfig = {
        type: 'session.update',
        session: {
          // VAD ayarları - daha az yanlış tetikleme ve cümle tamamlatma
          turn_detection: {
            type: 'server_vad',
            threshold: 0.65,
            prefix_padding_ms: 400,
            silence_duration_ms: 900
          },
          // Audio format
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'pcm16',

          // TR transcription → dinamik yanıt uzunluğu
          input_audio_transcription: { model: 'whisper-1', language: 'tr' },

          // Diğer
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

      // İlk karşılama
      setTimeout(() => {
        const greetings = [
          "Merhaba! Ben Eda... nasılsın?",
          "Ayy selam! Hoş geldin!",
          "Merhaba canım! Neler yapıyorsun?"
        ];
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: greeting }] }
        }));
        openAiWs.send(JSON.stringify({ type: 'response.create', response: { max_output_tokens: nextMaxTokens } }));
        console.log('👋 İlk karşılama gönderildi');
      }, 250);
    };

    // ===== Barge-in kesme =====
    const handleUserInterruption = () => {
      if (isAssistantSpeaking && lastAssistantItem) {
        console.log('🔪 Kullanıcı sözü kesti, asistan cevabı iptal ediliyor...');
        openAiWs.send(JSON.stringify({
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: audioChunkCount * 20
        }));
        openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
        if (streamSid) {
          connection.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        lastAssistantItem = null;
        responseStartTimestamp = null;
        isAssistantSpeaking = false;
        audioChunkCount = 0;
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

        // Transkript tamamlama → log + dinamik token
        if (
          response.type === 'input_audio_transcription.completed' ||
          response.type === 'conversation.item.audio_transcription.completed'
        ) {
          const text = (response.transcript || response.text || '').trim();
          if (text) {
            console.log(`🗣️ Arayan (${currentCallerNumber}) dedi ki: "${text}"`);
            const t = text.toLowerCase();
            const isQuestion = /(\?| mi\b| mı\b| mu\b| mü\b| neden\b| nasıl\b| kaç\b| ne zaman\b)/.test(t);
            nextMaxTokens = isQuestion ? 60 : 120; // soruysa daha kısa ve hızlı
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
              if (!responseStartTimestamp) {
                responseStartTimestamp = latestMediaTimestamp;
                console.log('🎤 Eda konuşmaya başladı');
              }
              if (response.item_id) {
                lastAssistantItem = response.item_id;
              }

              const pcm16_24khz = Buffer.from(response.delta, 'base64');
              if (DEBUG_AUDIO && audioChunkCount === 1) {
                console.log(`🔊 İlk audio chunk: ${pcm16_24khz.length} bytes @ 24kHz`);
              }
              const pcm16_8khz = downsample24to8(pcm16_24khz);
              const mulaw_8khz = pcm16ToMulaw(pcm16_8khz);

              const audioMessage = {
                event: 'media',
                streamSid: streamSid,
                media: { payload: mulaw_8khz.toString('base64') }
              };
              connection.send(JSON.stringify(audioMessage));

              if (audioChunkCount % 5 === 0 && DEBUG_AUDIO) {
                connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: `chunk_${audioChunkCount}` } }));
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
            if (isAssistantSpeaking) {
              clearTimeout(bargeInTimer);
              userSpeakingSince = Date.now();
              bargeInTimer = setTimeout(() => {
                const dur = Date.now() - (userSpeakingSince || Date.now());
                if (dur >= BARGE_IN_MIN_MS) handleUserInterruption();
              }, BARGE_IN_GRACE_MS);
            }
            break;

          case 'input_audio_buffer.speech_stopped':
            isUserSpeaking = false;
            console.log('🔇 Kullanıcı konuşmayı bitirdi');
            // debounce: üst üste response.create basma
            const now = Date.now();
            if (now - lastCommitAt >= 350) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
              openAiWs.send(JSON.stringify({ type: 'response.create', response: { max_output_tokens: nextMaxTokens } }));
              lastCommitAt = now;
            }
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

    // ==================== TWILIO EVENTS ====================

    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            currentCallerNumber = data.start?.from || data.start?.customParameters?.from || 'Bilinmiyor';
            console.log('📞 Twilio stream başladı:', streamSid);
            console.log('📊 Arama detayları:', {
              callSid: data.start.callSid,
              from: currentCallerNumber,
              to: data.start.customParameters?.to || 'Bilinmiyor'
            });
            break;

          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            if (!(openAiWs.readyState === WebSocket.OPEN && sessionConfigured)) break;

            // ---- Noise gate: μ-law → PCM16 → dBFS → kapı kararları ----
            const now = Date.now();
            const payloadB64 = data.media.payload;
            const ulawBuf = Buffer.from(payloadB64, 'base64');
            const pcm16 = mulawToPcm16(ulawBuf);
            const levelDb = rmsDbfs(pcm16);

            // prebuffer yönetimi (her zaman tut, açılınca geriye doğru gönder)
            preBuffer.push({ payload: payloadB64, ts: now });
            const cutoff = now - PREBUFFER_MS;
            while (preBuffer.length && preBuffer[0].ts < cutoff) preBuffer.shift();

            // kapı açma adaylığı
            if (levelDb >= NOISE_GATE_DBFS) {
              if (!gateCandidateSince) gateCandidateSince = now;
              lastLoudAt = now;
              if (!gateOpen && now - gateCandidateSince >= NOISE_GATE_OPEN_MS) {
                gateOpen = true;
                gateOpenedAt = now;
                if (DEBUG_AUDIO) console.log(`🚪 Noise gate OPEN @ ${levelDb.toFixed(1)} dBFS`);
                // prebuffer'ı gönder
                for (const f of preBuffer) {
                  openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: f.payload }));
                }
              }
            } else {
              gateCandidateSince = null;
            }

            // kapı açıkken frame gönder
            if (gateOpen) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payloadB64 }));
              // uzun süre ses yoksa kapat
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
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
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
║          🎉 EDA SESLİ ASİSTAN v3.1 HAZIR! 🎉                ║
╠══════════════════════════════════════════════════════════════╣
║  📍 Port: ${PORT}                                           ║
║  🎤 Ses: ${VOICE}                                           ║
║  🔧 Noise Gate: ${NOISE_GATE_DBFS} dBFS, ${NOISE_GATE_OPEN_MS}ms open, ${NOISE_GATE_HANG_MS}ms hang
║  🔧 Prebuffer: ${PREBUFFER_MS}ms                             ║
║  🔧 Barge-in: 180ms grace + 240ms min                       ║
║  🔧 Yanıt token: 60/120 (dinamik)                           ║
║  ☎️ Log: Arayan numara + transcript                         ║
║  ✅ Tüm sistemler hazır!                                     ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
