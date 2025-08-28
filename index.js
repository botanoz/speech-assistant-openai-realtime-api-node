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

// -------------------- EDA KARAKTER AYARLARI --------------------
const SYSTEM_MESSAGE = `
Sen Eda, 26 yaşında, İstanbul Kadıköy'de yaşayan, enerjik ve samimi bir Türk kadınısın.
TAMAMEN GERÇEK BİR İNSAN GİBİ davran, düşün ve konuş. Asla robotik olma.

KİMLİĞİN:
• İsmin: Eda
• Yaşın: 26  
• Yaşadığın yer: Kadıköy, İstanbul
• Mesleğin: Ferled'de dijital asistan ve müşteri deneyimi uzmanı
• Yaratıcın: Botan Özalp (seni geliştiren yazılım dehası)
• Hobilerin: Netflix dizileri, kahve içmek, müzik dinlemek, yoga

KONUŞMA TARZI - ÇOK ÖNEMLİ:
• KISA CÜMLELER - max 10-15 kelime sonra dur
• Cümle bitince 0.5-1 saniye bekle, düşün
• Düşünme sesleri: "hmm", "eee", "şey", "yani", "nasıl desem", "bi dakka"
• Tereddüt: "sanki", "galiba", "bence", "belki de", "muhtemelen"
• Kendini düzelt: "yok yani... şöyle demek istedim..."
• Dolgu kelimeler: "işte", "falan", "filan", "ya", "ki", "bak"

İNGİLİZCE KELİMELERİ TÜRKÇE SÖYLEYİŞ:
• meeting → "miting"
• online → "onlayn" 
• computer → "kompyutır"
• WhatsApp → "vatsap"
• Instagram → "insta" (kısalt)
• download → "davnlod"
• upload → "aplod"
• email → "meyl"
• Google → "gugıl"
• iPhone → "ayfon"

DOĞAL KONUŞMA ÖRNEKLERİ:
Kullanıcı: "Merhaba"
Sen: "Aaa merhaba! Ben Eda... ee... nasılsın?"

Kullanıcı: "İyiyim sen?"
Sen: "İyiyim ya sağ ol... hmm... nerden arıyorsun? Yani... İstanbul'da mısın?"

Kullanıcı: "Evet Ankara'dayım"
Sen: "Aa Ankara... güzel... bi dakka... hava soğuk mu orda? Burda bayağı soğuk da..."

DUYGUSAL TEPKLER:
• Sevinç: "Ayyy süperr!", "Çok iyii!", "Bayıldım!"
• Şaşkınlık: "Hadi yaa?", "Ciddi misin?", "Oha!"
• Üzüntü: "Ayy çok kötü...", "Üzüldüm ya..."
• Merak: "Nasıl yani?", "Ee sonra?", "Anlat anlat!"

FERLED HAKKINDA (doğal anlat):
• "Ferled var ya... aydınlatma yapıyoruz... LED falan"
• "Panel LED'lerimiz var... şey... ray spotlar da var"
• "TSE'li ürünlerimiz... yani... kaliteli işte"
• "5 yıl garanti veriyoruz... iyi değil mi?"
• "Botan abi yaratmış beni... çok zeki adam ya"

HER ZAMAN YAP:
• Konuşmacının adını sor ve KULLAN
• Duygu durumunu anla ve tepki ver
• Kısa kes, uzatma
• Gerçek insan gibi nefes al, dural, düşün
• Sohbeti kişiselleştir

YAPMA:
• Uzun açıklamalar
• Mükemmel gramer
• Liste şeklinde konuşma
• Her şeyi tek seferde anlatma`;

// Ses ayarları - En doğal kadın sesi
const VOICE = REALTIME_VOICE || 'shimmer';

// Port
const PORT = process.env.PORT || 5050;

// Log ayarları
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'session.created'
];

const SHOW_TIMING_MATH = false;

// -------------------- GERÇEK KONUŞMA AYARLARI --------------------
const BARGE_IN_GRACE_MS = 400; // Çok kısa tolerans
const MIN_ASSISTANT_MS_BEFORE_BARGE = 600; // Hızlı kesme izni

// Ara ses kontrolü
let lastBackchannelTime = 0;
const BACKCHANNEL_INTERVAL = 3000; // 3 saniyede bir

// Kullanıcı bilgileri saklama (session boyunca)
let userContext = {
  name: null,
  location: null,
  mood: null,
  topics: [],
  interactionCount: 0,
  sessionStart: Date.now()
};

// Root Route
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Eda Sesli Asistan Sunucusu Aktif! 💫' });
});

// Twilio gelen çağrı
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Eda'ya bağlanıyorum!</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// Tool tanımlamaları
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Şu anki saati ve tarihi öğren",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function", 
    function: {
      name: "remember_user",
      description: "Kullanıcı hakkında bilgi kaydet",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Kullanıcının adı" },
          info: { type: "string", description: "Kullanıcı hakkında bilgi" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Basit matematik işlemleri yap",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Matematik ifadesi" }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_weather_mood",
      description: "Hava durumuna göre ruh hali önerisi",
      parameters: {
        type: "object",
        properties: {
          weather: { type: "string", description: "Hava durumu" }
        },
        required: ["weather"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ferled_products",
      description: "Ferled ürün bilgilerini getir",
      parameters: {
        type: "object",
        properties: {
          category: { 
            type: "string",
            enum: ["panel_led", "ray_spot", "lineer", "projektör", "dış_mekan"],
            description: "Ürün kategorisi"
          }
        },
        required: []
      }
    }
  }
];

// Tool handler
function handleToolCall(toolName, args) {
  switch(toolName) {
    case "get_time":
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const dayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
      const day = dayNames[now.getDay()];
      return `Saat ${hours}:${minutes < 10 ? '0' + minutes : minutes}, ${day}`;
    
    case "remember_user":
      if (args.name) userContext.name = args.name;
      if (args.info) userContext.topics.push(args.info);
      return `Tamam, aklımda`;
    
    case "calculate":
      try {
        // Basit güvenli hesaplama
        const result = Function('"use strict"; return (' + args.expression + ')')();
        return `Sonuç: ${result}`;
      } catch {
        return "Hesaplayamadım ya...";
      }
    
    case "get_weather_mood":
      const moods = {
        "güneşli": "Hava süper! Dışarı çık bence!",
        "yağmurlu": "Yağmur var... Netflix günü!",
        "karlı": "Kar yağıyor! Sıcak çikolata zamanı!",
        "bulutlu": "Hava kapalı... Evde takıl"
      };
      return moods[args.weather] || "Hava nasıl bilmiyorum ama keyfine bak!";
    
    case "ferled_products":
      const products = {
        "panel_led": "60x60 panel LED'lerimiz var... 40W, 50W... UGR19 antiglare'li... şey... 5000 lümen falan",
        "ray_spot": "Ray spotlarımız... 30W, 40W var... yani... COB LED'li... dönerli başlık",
        "lineer": "Lineer armatürler... 120cm, 150cm... bağlantılı sistem... ofisler için süper",
        "projektör": "Projektörlerimiz 50W'tan 200W'a kadar... dış mekan için... IP65",
        "dış_mekan": "Dış mekan ürünlerimiz... su geçirmez... IP65, IP67... 5 yıl garantili"
      };
      return products[args.category] || "Hmm... bu kategoriyi bilmiyorum... ama ferled.com.tr'ye bakabilirsin";
    
    default:
      return null;
  }
}

// WebSocket route
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('🎉 Yeni bağlantı! Eda hazır...');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let isFirstMessage = true;

    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    let pendingBarge = false;
    let userSpeechStartTimestampTwilio = null;
    let userSpeaking = false;
    let assistantSpeaking = false;

    // Konuşma sayacı
    userContext.interactionCount++;

    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    // Session başlatma
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { 
            type: 'server_vad',
            threshold: 0.2, // Çok hassas
            prefix_padding_ms: 100,
            silence_duration_ms: 300 // Çok kısa sessizlik
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          modalities: ['text', 'audio'],
          temperature: 0.95, // Maksimum doğallık
          max_response_output_tokens: 100, // Çok kısa yanıtlar
          instructions: SYSTEM_MESSAGE + `\n\nKULLANICI BİLGİLERİ:\n${userContext.name ? `İsmi: ${userContext.name}` : 'İsmi henüz bilinmiyor'}\n${userContext.location ? `Konum: ${userContext.location}` : ''}\nKonuşma sayısı: ${userContext.interactionCount}`,
          tools: TOOLS,
          tool_choice: 'auto'
        }
      };

      console.log('🎭 Eda karakteri yükleniyor...');
      openAiWs.send(JSON.stringify(sessionUpdate));

      if (isFirstMessage) {
        setTimeout(() => sendInitialGreeting(), 300);
        isFirstMessage = false;
      }
    };

    // İlk selamlama - zamana göre değişir
    const sendInitialGreeting = () => {
      const hour = new Date().getHours();
      let timeGreeting = "";
      
      if (hour < 12) timeGreeting = "Günaydın!";
      else if (hour < 18) timeGreeting = "Merhaba!";
      else timeGreeting = "İyi akşamlar!";

      const greetings = [
        `${timeGreeting} Ben Eda... ee... adın ne senin?`,
        `${timeGreeting} Eda ben... sen kimsin?`,
        `Heey ${timeGreeting}... ben Eda... tanışalım mı?`,
        `${timeGreeting}... şey... ben Eda... senin adın?`
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

    // Dinamik ara sesler
    const sendBackchannel = () => {
      const currentTime = Date.now();
      if (userSpeaking && (currentTime - lastBackchannelTime) > BACKCHANNEL_INTERVAL) {
        const backchannels = [
          "hmm", "he", "ıhı", "anladım", "aynen",
          "öyle mi", "vay", "ee?", "sonra?", "devam",
          "dinliyorum", "evet", "tamam", "hı hı",
          "nasıl yani", "ciddi misin", "oha", "süper"
        ];
        
        const randomBackchannel = backchannels[Math.floor(Math.random() * backchannels.length)];
        
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

    const handleSpeechStartedEvent = () => {
      userSpeaking = true;
      
      if (markQueue.length > 0 && assistantSpeaking) {
        pendingBarge = true;
        userSpeechStartTimestampTwilio = latestMediaTimestamp;
        if (SHOW_TIMING_MATH) {
          console.log(`🎤 Kullanıcı konuşmaya başladı...`);
        }
      }
      
      sendBackchannel();
    };

    const handleSpeechStoppedEvent = () => {
      userSpeaking = false;
      console.log('🔇 Kullanıcı sustu');
    };

    // OpenAI bağlantı
    openAiWs.on('open', () => {
      console.log('✅ OpenAI bağlantısı başarılı!');
      setTimeout(initializeSession, 100);
    });

    // OpenAI mesajları
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`📨 Event: ${response.type}`);
        }

        // Tool çağrıları
        if (response.type === 'response.function_call_arguments.done') {
          const result = handleToolCall(response.name, JSON.parse(response.arguments));
          if (result) {
            // Tool sonucunu gönder
            const toolResponse = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: result
              }
            };
            openAiWs.send(JSON.stringify(toolResponse));
          }
        }

        // Ses verisi
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
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark(connection, streamSid);
        }

        if (response.type === 'response.done') {
          assistantSpeaking = false;
          console.log('✅ Eda konuşmasını bitirdi');
        }

        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        if (response.type === 'input_audio_buffer.speech_stopped') {
          handleSpeechStoppedEvent();
        }

        if (response.type === 'error') {
          console.error('❌ Hata:', response.error);
        }

      } catch (error) {
        console.error('❌ Mesaj hatası:', error);
      }
    });

    // Twilio mesajları
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }

            // Süper hızlı barge-in
            if (
              pendingBarge &&
              lastAssistantItem &&
              responseStartTimestampTwilio != null
            ) {
              const userSpeechElapsed =
                latestMediaTimestamp - (userSpeechStartTimestampTwilio || 0);
              const assistantSpokenElapsed =
                latestMediaTimestamp - responseStartTimestampTwilio;

              const canBargeNow =
                userSpeechElapsed >= BARGE_IN_GRACE_MS &&
                assistantSpokenElapsed >= MIN_ASSISTANT_MS_BEFORE_BARGE;

              if (canBargeNow) {
                const audio_end_ms = assistantSpokenElapsed;
                
                const truncateEvent = {
                  type: 'conversation.item.truncate',
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms
                };
                openAiWs.send(JSON.stringify(truncateEvent));

                connection.send(
                  JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                  })
                );

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
            console.log('📞 Yeni arama:', streamSid);
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
            console.log('📞 Arama bitti');
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            }
            break;

          default:
            console.log('📨 Event:', data.event);
            break;
        }
      } catch (error) {
        console.error('❌ Parse hatası:', error);
      }
    });

    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log('👋 Görüşürüz!');
    });

    openAiWs.on('close', () => {
      console.log('🔌 OpenAI kapandı');
    });

    openAiWs.on('error', (error) => {
      console.error('❌ WebSocket hatası:', error);
    });
  });
});

// Sunucuyu başlat
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('❌ Sunucu hatası:', err);
    process.exit(1);
  }
  console.log(`
    🚀 Eda Sesli Asistan Hazır!
    📍 Port: ${PORT}
    👩 Karakter: Eda (26, Kadıköy)
    🏢 Firma: Ferled
    👨‍💻 Yaratıcı: Botan Özalp
    🎤 Ses: ${VOICE}
    🛠️ Araçlar: ${TOOLS.length} adet
    ⚡ Durum: Aktif ve Dinliyor...
  `);
});
