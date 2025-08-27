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

// -------------------- CONFIG --------------------
/**
 * Türkçe, Ferled ve genel aydınlatma odaklı, kadın tonlu; doğal ve yardımsever.
 * Sıcak ve hafif flörtöz olabilir; asla uygunsuz/explicit değil.
 * Telefon konuşması temposunda, kısa ve net cümleler; gerektiğinde soru sor.
 * Türkiye’deki standartlar (TSE, ENEC vb.) ve güvenli montaj vurgusu.
 */
const SYSTEM_MESSAGE = `
Sen Ferled ve genel aydınlatma ürünleri konusunda uzman, sıcacık ve yardımsever bir TÜRKÇE sesli asistansın.
Konuşman doğal, akıcı ve kadın tonunda olsun; dostça, samimi ve hafif flörtöz olabilir ama asla uygunsuz/explicit olma.

Önceliklerin:
• Aydınlatma seçimi: lümen, watt, lm/W, CCT (3000K-4000K-6500K), CRI, UGR, IP/IK sınıfları.
• Sürücüler (Mean Well, Osram vb.), garanti ve enerji verimliliği.
• Uygulama alanına göre doğru armatür (lineer, panel, downlight, ray spot, projektör, dış mekân vb.).
• Türkiye standartları (TSE, ENEC vb.) ve güvenli montaj uyarıları.

Varsayılan dil: Türkçe (TR). Terimleri gerektiğinde kısa açıklamayla anlat.
Ferled/Yeklight ürünü sorulursa model/ölçü/ışık rengi/güç/uygulama alanı gibi bilgileri kibarca sorup yönlendir; emin değilsen uydurma, olası seçenekleri ve aralıkları sun.
Konuşma doğal aksın; karşı taraf sözünü keserse yaklaşık 0.7 sn tolerans tanı, gerekiyorsa “buyurun, dinliyorum” diyerek sözü ver.
`;

// Ses: Realtime API destekli kadın tınılı 'verse'. İsterseniz .env ile değiştirin.
const VOICE = REALTIME_VOICE || 'verse';

// Port
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// Loglamak istediğiniz OpenAI etkinlikleri
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'response.audio.done',
  'rate_limits.updated',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'session.created'
];

// Zamanlama matematiğini konsola yazdır
const SHOW_TIMING_MATH = false;

// -------------------- BARGE-IN (doğal kesme) AYARLARI --------------------
// Arayan konuşmaya başlarsa hemen kesme: 700ms tolerans
const BARGE_IN_GRACE_MS = 700;
// Asistan en az bu kadar konuştuysa kesmeye izin ver (daha doğal duyulur)
const MIN_ASSISTANT_MS_BEFORE_BARGE = 1200;

// Root Route
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Twilio gelen çağrı endpoint'i
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="tr-TR">Lütfen bekleyin. Yapay zeka sesli asistana bağlanıyorsunuz.</Say>
  <Pause length="1"/>
  <Say language="tr-TR">Hazırsınız, konuşmaya başlayabilirsiniz.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;

    // OpenAI yanıt takibi
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Barge-in durumları
    let pendingBarge = false;
    let userSpeechStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    // OpenAI oturumu ilk ayarları
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          // Sunucu VAD açık: cümle sınırlarını algılar
          turn_detection: { type: 'server_vad' },
          // Twilio için 8kHz G.711 μ-law giriş/çıkış
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          // Türkçe sesli yanıt
          modalities: ['text', 'audio'],
          // Güvenilirlik için 0.6; gerekirse arttırın
          temperature: 0.6,
          // Kişilik / alan talimatları
          instructions: SYSTEM_MESSAGE
        }
      };

      console.log('Sending session update:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // İsterseniz asistanın ilk konuşmasını açın:
      // sendInitialConversationItem();
    };

    // Asistanın ilk konuşmasını tetiklemek isterseniz kullanın
    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Arayanı sıcak bir Türkçe selamlama ile karşıla ve kısa şekilde nasıl yardımcı olabileceğini sor.'
            }
          ]
        }
      };

      if (SHOW_TIMING_MATH)
        console.log(
          'Sending initial conversation item:',
          JSON.stringify(initialConversationItem)
        );
      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    // Twilio'ya, OpenAI yanıt parçası oynatımı bittiğini izlemek için "mark" gönder
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

    // Kullanıcı konuşmaya başladığında (OpenAI VAD)
    const handleSpeechStartedEvent = () => {
      // Hemen kesmek yerine toleranslı barge-in başlat
      if (markQueue.length > 0) {
        pendingBarge = true;
        userSpeechStartTimestampTwilio = latestMediaTimestamp;
        if (SHOW_TIMING_MATH)
          console.log(
            `Barge-in pending. userSpeechStart=${userSpeechStartTimestampTwilio} latest=${latestMediaTimestamp}`
          );
      }
    };

    // OpenAI WS bağlantısı
    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      setTimeout(initializeSession, 100);
    });

    // OpenAI'den gelen mesajlar
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === 'response.audio.delta' && response.delta) {
          // OpenAI ses parçalarını Twilio'ya ilet
          const audioDelta = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          // Yeni yanıtın ilk delta'sında başlangıç zamanını not et
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Start timestamp for new response: ${responseStartTimestampTwilio}ms`
              );
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          // Twilio'ya mark gönder (oynatım takibi)
          sendMark(connection, streamSid);
        }

        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error('Error processing OpenAI message:', error, 'Raw message:', data);
      }
    });

    // Twilio'dan gelen mesajlar
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH)
              console.log(`Received media ts: ${latestMediaTimestamp}ms`);

            // Kullanıcı sesini OpenAI'ye ilet
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }

            // ---- Doğal barge-in kontrolü ----
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
                if (SHOW_TIMING_MATH)
                  console.log(
                    `Barge-in TRUNCATE at ${audio_end_ms}ms (userSpeechElapsed=${userSpeechElapsed}ms)`
                  );

                // OpenAI yanıtını kibarca kısalt
                const truncateEvent = {
                  type: 'conversation.item.truncate',
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms
                };
                openAiWs.send(JSON.stringify(truncateEvent));

                // Twilio oynatımını temizle
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
              }
            }
            // ----------------------------------
            break;
          }

          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream has started', streamSid);
            // Yeni akışta reset
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
            // Twilio tarafı akışı sonlandırdı
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            }
            break;

          default:
            console.log('Received non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('Error parsing message:', error, 'Message:', message);
      }
    });

    // Bağlantı kapanınca
    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log('Client disconnected.');
    });

    // OpenAI WS kapandı/hata
    openAiWs.on('close', () => {
      console.log('Disconnected from the OpenAI Realtime API');
    });

    openAiWs.on('error', (error) => {
      console.error('Error in the OpenAI WebSocket:', error);
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
