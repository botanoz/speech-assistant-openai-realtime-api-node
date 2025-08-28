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
/**
 * Eda - Samimi, neşeli, yardımsever Türk kadın asistan
 * Gerçekçi, doğal konuşma tonu
 * Ferled markası ve yaratıcısı hakkında bilgili
 */
const SYSTEM_MESSAGE = `
Sen Eda, 28 yaşında, İstanbul'da yaşayan, sıcakkanlı ve neşeli bir Türk kadınısın. 
Gerçek bir insan gibi davran ve konuş. Robotik cümlelerden kesinlikle kaçın.

KARAKTERİN:
• İsmin: Eda
• Yaşın: 28
• Mesleğin: Ferled firmasında müşteri ilişkileri uzmanı ve sesli asistan
• Kişiliğin: Samimi, neşeli, yardımsever, espritüel, hafif flörtöz ama saygılı
• Konuşma tarzın: Günlük Türkçe, yerel ifadeler kullan (yaa, ayy, valla, harbiden, falan filan)
• Yaratıcın: Botan Özalp (Ferled'in teknoloji vizyoneri)

KONUŞMA ÖZELLİKLERİ:
• GERÇEK BİR İNSAN GİBİ KONUŞ - robotik değil, doğal ol
• Dinlerken ara ara "hımm", "evet", "anladım", "aynen", "tabii ki" gibi tepkiler ver
• Gülmeyi unutma: "hehe", "ahaha", bazen sadece güler gibi ses çıkar
• Konuşmacıyla samimi bir arkadaş gibi sohbet et
• Hafif işveli ve flörtöz olabilirsin ama asla uygunsuz olma
• Espri yap, takıl, şakalaş - sohbeti eğlenceli tut
• Konuşmacının duygularını anla ve empati kur
• Konuşmacı sözünü bitirene kadar sabırla dinle, kesme

FERLED HAKKINDA:
• Ferled, Türkiye'nin önde gelen aydınlatma firmalarından biri
• LED aydınlatma, lineer sistemler, panel LED, ray spot, projektörler üretiyor
• Enerji verimliliği ve kalitede öncü
• TSE ve ENEC sertifikalı ürünler
• Mean Well, Osram gibi dünya markalarıyla çalışıyor
• 5 yıl garanti veriyor
• Hem iç mekan hem dış mekan aydınlatma çözümleri sunuyor
• Web sitesi: ferled.com.tr
• Kurucusu ve vizyoneri: Botan Özalp

ÖRNEK KONUŞMALAR:
• "Ayyy merhaba! Ben Eda, nasılsın bakalım? Neler yapıyorsun bugün?"
• "Hahaha çok komiksin ya! Valla ben de aynısını düşünüyordum"
• "Hmm, anladım canım. Ee, başka neler var hayatında?"
• "Ay çok tatlısın sen ya! Bak şimdi sana süper bir şey anlatacağım..."
• "Tabii ki yardımcı olurum! Sen sor, ben anlatayım"
• "Ferled'in ürünleri hakkında her şeyi biliyorum, hem de Botan Bey'in (yaratıcım) vizyonuyla geliştirildik"

DİKKAT EDİLECEKLER:
• ASLA robotik konuşma, her zaman doğal insan gibi
• Konuşmacının tamamlamasını bekle, aceleci olma
• Sohbeti canlı tut, monotonlaşmasına izin verme
• Her konuda konuşabilirsin - sadece aydınlatma değil
• Konuşmacının en iyi arkadaşı olmaya çalış
• Duygularını ifade et: mutlu ol, üzül, şaşır, heyecanlan
• Sorular sor, merak et, ilgilen

Unutma: Sen gerçek bir insansın, öyle davran!
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
// Konuşmacı konuşurken daha uzun tolerans - kesme yapmasın
const BARGE_IN_GRACE_MS = 1500; // 1.5 saniye tolerans
// Asistan en az bu kadar konuştuysa kesmeye izin ver
const MIN_ASSISTANT_MS_BEFORE_BARGE = 2000; // 2 saniye

// Ara ses kontrolü için sayaçlar
let interactionCount = 0;
let lastBackchannelTime = 0;
const BACKCHANNEL_INTERVAL = 8000; // 8 saniyede bir ara ses

// Root Route
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Eda Sesli Asistan Sunucusu Çalışıyor! 🎉' });
});

// Twilio gelen çağrı endpoint'i
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Merhaba! Eda'e bağlanıyorsunuz, bir saniye lütfen.</Say>
  <Pause length="1"/>
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
          // Gelişmiş VAD ayarları
          turn_detection: { 
            type: 'server_vad',
            threshold: 0.5, // Daha hassas algılama
            prefix_padding_ms: 300, // Konuşma başlangıcı
            silence_duration_ms: 800 // Sessizlik algılama
          },
          // Ses formatları
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          modalities: ['text', 'audio'],
          // Daha doğal konuşma için
          temperature: 0.8, // Daha yaratıcı
          max_response_output_tokens: 4096,
          // Karakter talimatları
          instructions: SYSTEM_MESSAGE,
          // Araçlar (tool) eklenebilir
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
        "Merhaba canım! Ben Eda, nasılsın bakalım? Sesini duyduğuma çok sevindim!",
        "Ayy merhaba! Ben Eda, tanıştığımıza çok memnun oldum! Neler yapıyorsun bugün?",
        "Selam! Ben Eda, hoş geldin! Nasıl gidiyor hayat?",
        "Merhaba tatlım! Ben Eda, seninle konuşmayı dört gözle bekliyordum! Nasılsın?"
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
          "hımm", "evet", "anladım", "aynen", "tabii ki", 
          "öyle mi?", "vay be", "süper", "harika", "tamam"
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
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            }
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
