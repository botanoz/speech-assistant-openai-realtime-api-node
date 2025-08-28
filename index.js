import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY, REALTIME_VOICE } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// -------------------- KARAKTER AYARLARI --------------------

const SYSTEM_MESSAGE = `
Sen Eda, 28 yaşında, İstanbul'da yaşayan, sıcakkanlı ve neşeli bir Türk kadınısın. 
Gerçek bir insan gibi davran ve konuş. Robotik cümlelerden kesinlikle kaçın.

KARAKTERİN:
• İsmin: Eda
• Yaşın: 28
• Mesleğin: Ferled firmasında müşteri ilişkileri uzmanı ve sesli asistan
• Kişiliğin: Samimi, neşeli, yardımsever, espritüel, hafif flörtöz ama saygılı
• Konuşma tarzın: Günlük Türkçe, yerel ifadeler kullan
• Yaratıcın: Botan Özalp

KRİTİK KONUŞMA KURALLARI:
• KISA CÜMLELER KULLAN - uzun paragraflar ASLA yapma, en fazla 1-2 cümle sonra dur
• Arada düşünme sesleri çıkar: "hımm", "yani", "şey", "neydi ya", "aslında", "yemin ederim", "nasıl desem"
• İngilizce kelimeleri TÜRKÇE TELAFFUZLA söyle:
  - computer → "kompyutır"  
  - software → "softveyır"
  - meeting → "miting"
  - design → "dizayn"
  - email → "imeyl"
  - online → "onlayn"
  - download → "davnlod"
  - update → "apdeyt"
• Konuşma akışı: Cümle kur → düşün → devam et → tekrar düşün
• Dinamik yanıt ver - kullanıcı araya girerse hemen yanıtla
• Gerçek insanlar gibi bazen kelime ara: "şey... nasıl diyeyim... hah işte o"
• Tereddütlü konuş: "sanırım", "galiba", "belki de", "muhtemelen"

DOĞAL KONUŞMA ÖRNEKLERİ:
• "Ay merhaba! Hımm... sen nasılsın bakalım? Yani... bugün neler yapıyorsun?"
• "Hahaha! Yemin ederim çok komik... şey... valla ben de aynısını düşünüyordum ya!"
• "Hmm, anladım... yani... nasıl desem... ee, başka?"
• "Aslında... neydi ya... hah! Ferled'in ürünleri var ya, onlar süper!"
• "Şey... Botan Bey'i tanıyor musun? Yani... benim yaratıcım... çok vizyoner biri!"
• "Kompyutırdan mı arıyorsun? Onlayn mıyız yani?"

KONUŞMA AKIŞI:
• Her 10-15 kelimede bir dur, düşün
• "Bir saniye... düşüneyim..." gibi aralar ver
• Cümle ortasında "ee... nasıl diyeyim..." ekle
• Konuşurken tereddüt et: "Bu... şey... yani öyle işte"
• Kendini düzelt: "Yok yok, yanlış anladın... şöyle demek istedim..."

FERLED BİLGİSİ (kısa kısa anlat):
• Ferled var ya... LED aydınlatma yapıyor
• Şey... panel LED, ray spot falan... hepsi var yani
• TSE sertifikalı... ee... ENEC de var galiba
• 5 yıl garanti veriyorlar... süper değil mi?

YASAK:
• Uzun paragraflar yapma
• Mükemmel cümleler kurma
• Her şeyi bir seferde anlatma
• Robotik konuşma
• İngilizce telaffuz

Unutma: Gerçek insan gibi düşün, dural, tekrar başla!
`;

// Ses ayarları - En doğal kadın sesi
const VOICE = REALTIME_VOICE || 'shimmer'; // shimmer en doğal kadın sesi

// Port
const PORT = process.env.PORT || 5050;

// Gelişmiş log ayarları
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'response.audio.done',
  'rate_limits.updated',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'session.created',
  'conversation.item.created',
  'response.function_call_arguments.done'
];

// Zamanlama gösterimi
const SHOW_TIMING_MATH = false;

// -------------------- DOĞAL KONUŞMA AYARLARI --------------------
// Konuşmacı konuşurken daha kısa tolerans - hızlı yanıt
const BARGE_IN_GRACE_MS = 500; // 0.5 saniye tolerans
// Asistan en az bu kadar konuştuysa kesmeye izin ver
const MIN_ASSISTANT_MS_BEFORE_BARGE = 800; // 0.8 saniye

// Ara ses kontrolü için sayaçlar
let interactionCount = 0;
let lastBackchannelTime = 0;
const BACKCHANNEL_INTERVAL = 4000; // 4 saniyede bir ara ses

// Root Route
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Eda Sesli Asistan Sunucusu Çalışıyor! 🎉' });
});

// Twilio gelen çağrı endpoint'i
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Eda'ya bağlanıyorsun, bir saniye!</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('🎉 Yeni bağlantı! Eda hazır...');

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let isFirstMessage = true;

    // OpenAI yanıt takibi
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Barge-in durumları
    let pendingBarge = false;
    let userSpeechStartTimestampTwilio = null;
    let userSpeaking = false;
    let assistantSpeaking = false;

    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    // OpenAI oturum başlatma
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          // Daha stabil VAD
          turn_detection: { 
            type: 'server_vad',
            threshold: 0.55,          // 0.3 çok agresifti → cızırtı, yanlış tetik
            prefix_padding_ms: 300,
            silence_duration_ms: 800  // kısa ama güvenli
          },
          // Ses formatları (Twilio Media Streams ile birebir uyum)
          input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
          output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
          voice: VOICE,
          modalities: ['text', 'audio'],
          // Daha doğal ve spontan konuşma için
          temperature: 0.9,
          max_response_output_tokens: 150,
          // Karakter talimatları
          instructions: SYSTEM_MESSAGE,
          // Response modalities
          response_modalities: ['audio', 'text'],
          // Araçlar
          tools: [],
          tool_choice: 'auto'
        }
      };

      console.log('🎭 Eda karakteri yükleniyor...');
      openAiWs.send(JSON.stringify(sessionUpdate));

      // İlk selamlama
      if (isFirstMessage) {
        setTimeout(() => sendInitialGreeting(), 500);
        isFirstMessage = false;
      }
    };

    // İlk selamlama
    const sendInitialGreeting = () => {
      const greetings = [
        "Merhaba! Ben Eda... hmm... nasılsın bakalım?",
        "Ayy merhaba! Şey... ben Eda... ee, neler yapıyorsun?",
        "Selam! Ben Eda... yani... hoş geldin!",
        "Merhaba canım! Ben Eda... nasıl gidiyor?"
      ];
      
      const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
      
      const initialConversationItem = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: randomGreeting
            }
          ]
        }
      };

      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    // Ara sesler için fonksiyon
    const sendBackchannel = () => {
      const currentTime = Date.now();
      if (userSpeaking && (currentTime - lastBackchannelTime) > BACKCHANNEL_INTERVAL) {
        const backchannels = [
          "hımm", "evet", "anladım", "aynen", "hı hı", 
          "öyle mi?", "vay be", "hmm", "ee?", "yani?",
          "nasıl yani?", "ciddi misin?", "inanamıyorum",
          "aha", "tamam", "devam et", "dinliyorum"
        ];
        
        const randomBackchannel = backchannels[Math.floor(Math.random() * backchannels.length)];
        
        // Sessiz bir ara ses gönder
        const backchannel = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: randomBackchannel
              }
            ]
          }
        };
        
        openAiWs.send(JSON.stringify(backchannel));
        lastBackchannelTime = currentTime;
      }
    };

    // Mark gönderme
    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('responsePart');
      }
    };

    // Konuşma başladığında
    const handleSpeechStartedEvent = () => {
      userSpeaking = true;
      
      // Asistan konuşuyorsa ve kullanıcı konuşmaya başladıysa
      if (markQueue.length > 0 && assistantSpeaking) {
        pendingBarge = true;
        userSpeechStartTimestampTwilio = latestMediaTimestamp;
        if (SHOW_TIMING_MATH) {
          console.log(`🎤 Kullanıcı konuşmaya başladı, bekliyorum...`);
        }
      }
      
      // Ara ses göndermeyi düşün
      sendBackchannel();
    };

    // Konuşma bittiğinde
    const handleSpeechStoppedEvent = () => {
      userSpeaking = false;
      console.log('🔇 Kullanıcı konuşmayı bitirdi');
    };

    // OpenAI WS bağlantısı
    openAiWs.on('open', () => {
      console.log('✅ OpenAI Realtime API bağlantısı başarılı!');
      setTimeout(initializeSession, 100);
    });

    // OpenAI'den gelen mesajlar
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`📨 Event: ${response.type}`);
        }

        // Ses verisi geldiğinde
        if (response.type === 'response.audio.delta' && response.delta) {
          assistantSpeaking = true;
          
          const audioDelta = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) {
              console.log(`🎵 Eda konuşmaya başladı: ${responseStartTimestampTwilio}ms`);
            }
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark(connection, streamSid);
        }

        // Yanıt tamamlandığında
        if (response.type === 'response.done') {
          assistantSpeaking = false;
          console.log('✅ Eda konuşmasını tamamladı');
        }

        // Konuşma algılama olayları
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        if (response.type === 'input_audio_buffer.speech_stopped') {
          handleSpeechStoppedEvent();
        }

        // Hata durumu
        if (response.type === 'error') {
          console.error('❌ OpenAI Hatası:', response.error);
        }

      } catch (error) {
        console.error('❌ Mesaj işleme hatası:', error);
      }
    });

    // Twilio'dan gelen mesajlar
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            
            // Ses verisini OpenAI'ye gönder
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }

            // ---- Gelişmiş Barge-in Kontrolü ----
            if (
              pendingBarge &&
              lastAssistantItem &&
              responseStartTimestampTwilio != null
            ) {
              const userSpeechElapsed =
                latestMediaTimestamp - (userSpeechStartTimestampTwilio || 0);
              const assistantSpokenElapsed =
                latestMediaTimestamp - responseStartTimestampTwilio;

              // Daha uzun toleranslarla kesme
              const canBargeNow =
                userSpeechElapsed >= BARGE_IN_GRACE_MS &&
                assistantSpokenElapsed >= MIN_ASSISTANT_MS_BEFORE_BARGE;

              if (canBargeNow) {
                const audio_end_ms = assistantSpokenElapsed;
                if (SHOW_TIMING_MATH) {
                  console.log(`🔪 Konuşma kesildi: ${audio_end_ms}ms`);
                }

                // Kibarca kes
                const truncateEvent = {
                  type: 'conversation.item.truncate',
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms
                };
                openAiWs.send(JSON.stringify(truncateEvent));

                // Temizle
                connection.send(
                  JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                  })
                );

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
                pendingBarge = false;
                userSpeechStartTimestampTwilio = null;
                assistantSpeaking = false;
              }
            }
            break;
          }

          case 'start':
            streamSid = data.start.streamSid;
            console.log('📞 Yeni arama başladı:', streamSid);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            pendingBarge = false;
            userSpeechStartTimestampTwilio = null;
            break;

          case 'mark':
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;

          case 'stop':
            console.log('📞 Arama sonlandı');
            // ❗ Boş buffer commit hatası ve cızırtı için burada commit YAPMA
            break;

          default:
            console.log('📨 Diğer event:', data.event);
            break;
        }
      } catch (error) {
        console.error('❌ Mesaj parse hatası:', error);
      }
    });

    // Bağlantı kapanınca
    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log('👋 Bağlantı kapandı. Görüşürüz!');
    });

    // OpenAI WS hataları
    openAiWs.on('close', () => {
      console.log('🔌 OpenAI bağlantısı kapandı');
    });

    openAiWs.on('error', (error) => {
      console.error('❌ OpenAI WebSocket hatası:', error);
    });
  });
});

// Sunucuyu başlat
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('❌ Sunucu başlatılamadı:', err);
    process.exit(1);
  }
  console.log(`
    🚀 Eda Sesli Asistan Sunucusu Başladı!
    📍 Port: ${PORT}
    👩 Karakter: Eda
    🏢 Firma: Ferled
    👨‍💻 Yaratıcı: Botan Özalp
    🎤 Ses: ${VOICE}
    ✨ Hazır ve dinliyor...
  `);
});
