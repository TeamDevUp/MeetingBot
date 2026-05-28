const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CONFLUENCE_URL = process.env.CONFLUENCE_URL;
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL;
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN;
const CONFLUENCE_SPACE_KEY = process.env.CONFLUENCE_SPACE_KEY;
const VITO_CLIENT_ID = process.env.VITO_CLIENT_ID;
const VITO_CLIENT_SECRET = process.env.VITO_CLIENT_SECRET;

const MEETING_TYPES = {
  '1': { name: '주간 회의', parentId: '7405577' },
  '2': { name: 'iOS 회의록', parentId: '4751381' },
  '3': { name: '외부 미팅', parentId: '12976132' },
  '4': { name: '마일스톤 회고', parentId: '19726353' },
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const recordingSessions = new Map();
const pendingMinutes = new Map();

// ─── VITO API ──────────────────────────────────────────────

// VITO 액세스 토큰 발급
async function getVitoToken() {
  const res = await axios.post(
    'https://openapi.vito.ai/v1/authenticate',
    new URLSearchParams({
      client_id: VITO_CLIENT_ID,
      client_secret: VITO_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data.access_token;
}

// VITO STT 요청 → transcribe_id 반환
async function submitVitoTranscribe(wavPath, token) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(wavPath));
  form.append('config', JSON.stringify({
    diarization: { use_verification: false },
    use_multi_channel: false,
  }));

  const res = await axios.post(
    'https://openapi.vito.ai/v1/transcribe',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
    }
  );
  return res.data.id;
}

// VITO 결과 폴링 (완료될 때까지 대기)
async function pollVitoResult(transcribeId, token) {
  const url = `https://openapi.vito.ai/v1/transcribe/${transcribeId}`;
  while (true) {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { status, results } = res.data;
    if (status === 'completed') {
      return results.utterances
        .map(u => u.msg)
        .join(' ');
    }
    if (status === 'failed') throw new Error('VITO 변환 실패');
    await new Promise(r => setTimeout(r, 3000));
  }
}

// PCM → WAV 변환 (ffmpeg)
function pcmToWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', 'pipe:0', '-y', outputPath,
    ]);
    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 종료 코드: ${code}`));
    });
  });
}

// 녹음 → VITO STT 전체 흐름
async function transcribeWithVito(pcmChunks) {
  const ts = Date.now();
  const wavPath = `/tmp/meeting_${ts}.wav`;

  try {
    const combined = Buffer.concat(pcmChunks);
    await pcmToWav(combined, wavPath);

    const token = await getVitoToken();
    const transcribeId = await submitVitoTranscribe(wavPath, token);
    const transcript = await pollVitoResult(transcribeId, token);
    return transcript;
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

// ─── Confluence ────────────────────────────────────────────

function markdownToConfluence(content) {
  const lines = content.split('\n');
  const html = [];
  let inList = false, inTable = false;
  for (const line of lines) {
    if (line.startsWith('|')) {
      if (!inTable) { html.push('<table><tbody>'); inTable = true; }
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`);
      html.push(`<tr>${cells.join('')}</tr>`);
      continue;
    } else if (inTable) { html.push('</tbody></table>'); inTable = false; }
    if (line.startsWith('# ')) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h1>${line.slice(2)}</h1>`); }
    else if (line.startsWith('## ')) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h2>${line.slice(3)}</h2>`); }
    else if (line.startsWith('### ')) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h3>${line.slice(4)}</h3>`); }
    else if (line.startsWith('- ')) { if (!inList) { html.push('<ul>'); inList = true; } html.push(`<li>${line.slice(2)}</li>`); }
    else if (line.trim() === '') { if (inList) { html.push('</ul>'); inList = false; } html.push('<p></p>'); }
    else { if (inList) { html.push('</ul>'); inList = false; } html.push(`<p>${line}</p>`); }
  }
  if (inList) html.push('</ul>');
  if (inTable) html.push('</tbody></table>');
  return html.join('\n');
}

async function findExistingPage(title) {
  const auth = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');
  try {
    const res = await axios.get(`${CONFLUENCE_URL}/wiki/rest/api/content`, {
      params: { title, spaceKey: CONFLUENCE_SPACE_KEY, expand: 'version' },
      headers: { Authorization: `Basic ${auth}` },
    });
    return res.data.results.length > 0 ? res.data.results[0] : null;
  } catch { return null; }
}

async function uploadToConfluence(title, content, parentId) {
  const auth = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
  const htmlContent = markdownToConfluence(content);

  const existing = await findExistingPage(title);
  if (existing) {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    title = `${title} (${timeStr})`;
  }

  const res = await axios.post(
    `${CONFLUENCE_URL}/wiki/rest/api/content`,
    {
      type: 'page', title,
      space: { key: CONFLUENCE_SPACE_KEY },
      ancestors: [{ id: parentId }],
      body: { storage: { value: htmlContent, representation: 'storage' } },
    },
    { headers }
  );
  return res.data._links?.webui
    ? `${CONFLUENCE_URL}/wiki${res.data._links.webui}`
    : CONFLUENCE_URL;
}

// ─── Claude 회의록 생성 ────────────────────────────────────

async function generateMinutes(transcript, participants, meetingType) {
  const now = new Date();
  const today = `${now.getFullYear()}년 ${String(now.getMonth()+1).padStart(2,'0')}월 ${String(now.getDate()).padStart(2,'0')}일`;
  const todayTitle = now.toISOString().slice(0, 10);

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `다음은 오늘(${today}) ${meetingType.name} 내용입니다.\n참여자: ${participants}\n\n[회의 내용]\n${transcript}\n\n위 내용을 바탕으로 아래 형식에 맞게 회의록을 작성해주세요. 형식을 절대 변경하지 마세요.\n\n# ${todayTitle} 회의록\n\n## 날짜\n${today}\n\n## 참여자\n${participants || '[확인 필요]'}\n\n## 목표\n(회의 목표를 한 줄로 요약)\n\n## 자료\n(회의에서 언급된 링크나 자료. 없으면 -)\n\n## 토론 주제\n| 시간 | 토픽 | 발표자 | 비고 |\n|------|------|--------|------|\n(각 토론 주제별로 한 행씩. 비고에 주요 내용, 질답, 결정사항 상세 기록)\n\n## 조치 항목\n| 담당자 | 내용 | 기한 |\n|--------|------|------|\n\n## 결정 사항\n(최종 결정된 내용)\n\n## 관련 정보\n(참고 링크, 문서 등. 없으면 -)\n\n불명확한 부분은 [확인 필요]로 표시해주세요.`,
    }],
  });
  return { minutes: res.content[0].text, todayTitle };
}

// ─── 공통 업로드 ───────────────────────────────────────────

async function finishAndUpload(channel, minutes, todayTitle, meetingType) {
  await channel.send(`✅ **${meetingType.name} 회의록 생성 완료!**`);
  for (let i = 0; i < minutes.length; i += 1900) await channel.send(minutes.slice(i, i + 1900));
  await channel.send('☁️ Confluence 업로드 중...');
  try {
    const url = await uploadToConfluence(`${todayTitle} 회의록`, minutes, meetingType.parentId);
    await channel.send(`✅ **Confluence 업로드 완료!**\n🔗 ${url}`);
  } catch (e) {
    await channel.send(`⚠️ Confluence 업로드 실패: ${e.message}`);
  }
  const filename = `회의록_${todayTitle}.txt`;
  const filepath = `/tmp/${filename}`;
  fs.writeFileSync(filepath, minutes);
  await channel.send({ content: '📄 파일:', files: [{ attachment: filepath, name: filename }] });
  fs.unlinkSync(filepath);
}

// ─── 녹음 처리 ─────────────────────────────────────────────

async function processRecording(channel, userStreams, participants, meetingType) {
  await channel.send('🎙️ 음성을 텍스트로 변환 중... (VITO STT)');

  const allChunks = Object.values(userStreams).flat();
  if (allChunks.length === 0) {
    await channel.send('⚠️ 녹음된 데이터가 없어요.');
    return;
  }

  try {
    const transcript = await transcribeWithVito(allChunks);

    if (!transcript.trim()) {
      await channel.send('⚠️ 음성 변환 결과가 없어요.');
      return;
    }

    await channel.send(`✅ 변환 완료!\n\`\`\`\n${transcript.slice(0, 300)}${transcript.length > 300 ? '...' : ''}\n\`\`\``);
    await channel.send('📝 회의록 생성 중...');

    const { minutes, todayTitle } = await generateMinutes(transcript, participants.join(', '), meetingType);
    await finishAndUpload(channel, minutes, todayTitle, meetingType);

  } catch (e) {
    console.error('처리 오류:', e.message);
    await channel.send(`⚠️ 처리 중 오류가 발생했어요: ${e.message}`);
  }
}

// ─── 유저 스트림 구독 ──────────────────────────────────────

function subscribeUser(receiver, userId, userStreams) {
  if (userStreams.subscribed.has(userId)) return;
  userStreams.subscribed.add(userId);
  if (!userStreams.chunks[userId]) userStreams.chunks[userId] = [];

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 2000 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  opusStream.pipe(decoder);

  decoder.on('data', chunk => userStreams.chunks[userId].push(chunk));
  decoder.on('end', () => userStreams.subscribed.delete(userId));
  decoder.on('error', e => console.error('Decoder 오류:', e.message));
}

// ─── Discord 이벤트 ────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`✅ ${client.user.tag} 봇 시작됨!`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const channelId = message.channelId;

  // 회의 유형 선택 대기
  if (pendingMinutes.has(channelId)) {
    if (MEETING_TYPES[message.content]) {
      const meetingType = MEETING_TYPES[message.content];
      const data = pendingMinutes.get(channelId);
      pendingMinutes.delete(channelId);
      await message.channel.send(`✅ **${meetingType.name}** 으로 저장할게요!`);
      await message.channel.send('📝 회의록 생성 중...');
      const { minutes, todayTitle } = await generateMinutes(data.content, data.participants, meetingType);
      await finishAndUpload(message.channel, minutes, todayTitle, meetingType);
      return;
    } else if (message.content === '!취소') {
      pendingMinutes.delete(channelId);
      await message.channel.send('❌ 취소됐어요.');
      return;
    }
  }

  // !시작
  if (message.content.startsWith('!시작')) {
    if (!message.member?.voice?.channel) {
      await message.channel.send('❌ 먼저 음성 채널에 들어가 주세요!');
      return;
    }
    if (recordingSessions.has(message.guildId)) {
      await message.channel.send('⚠️ 이미 녹음 중이에요!');
      return;
    }
    const parts = message.content.split(' ');
    if (parts.length < 2 || !MEETING_TYPES[parts[1]]) {
      await message.channel.send('📂 **회의 유형을 함께 입력해주세요!**\n\n`!시작 1` — 주간 회의\n`!시작 2` — iOS 회의록\n`!시작 3` — 외부 미팅\n`!시작 4` — 마일스톤 회고');
      return;
    }

    const meetingType = MEETING_TYPES[parts[1]];
    const voiceChannel = message.member.voice.channel;
    const participants = voiceChannel.members.map(m => m.displayName);

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

    const userStreams = { subscribed: new Set(), chunks: {} };
    const receiver = connection.receiver;
    receiver.speaking.on('start', userId => subscribeUser(receiver, userId, userStreams));

    recordingSessions.set(message.guildId, { connection, userStreams, meetingType, participants, channel: message.channel });
    await message.channel.send(`🔴 **${meetingType.name} 녹음 시작!**\n참여자: ${participants.join(', ')}\n종료: \`!종료\``);

  // !종료
  } else if (message.content === '!종료') {
    if (!recordingSessions.has(message.guildId)) {
      await message.channel.send('❌ 진행 중인 녹음이 없어요!');
      return;
    }
    const session = recordingSessions.get(message.guildId);
    recordingSessions.delete(message.guildId);

    await new Promise(resolve => setTimeout(resolve, 2000));
    session.connection.destroy();

    await message.channel.send('⏹️ 녹음 종료! 처리 중...');
    await processRecording(session.channel, session.userStreams.chunks, session.participants, session.meetingType);

  // !회의록
  } else if (message.content.startsWith('!회의록')) {
    const content = message.content.replace('!회의록', '').trim();
    if (!content) {
      await message.channel.send('📋 **사용법**\n```\n!회의록\n여기에 회의 내용을 붙여넣으세요\n```');
      return;
    }
    let participants = '';
    if (message.member?.voice?.channel) {
      participants = message.member.voice.channel.members.map(m => m.displayName).join(', ');
    }
    pendingMinutes.set(channelId, { content, participants });
    await message.channel.send('📂 **어떤 회의인가요?**\n\n`1` — 주간 회의\n`2` — iOS 회의록\n`3` — 외부 미팅\n`4` — 마일스톤 회고\n\n취소: `!취소`');

  // !도움말
  } else if (message.content === '!도움말') {
    await message.channel.send('📋 **회의록 봇 사용법**\n\n**🎙️ 음성 녹음 방식**\n`!시작 1~4` — 음성 채널 녹음 시작\n`!종료` — 녹음 종료 → VITO STT → 회의록 → Confluence\n\n**📝 텍스트 입력 방식**\n`!회의록 [내용]` — 텍스트로 회의록 생성\n\n**유형**\n`1` 주간 | `2` iOS | `3` 외부 | `4` 회고');
  }
});

client.login(DISCORD_TOKEN);
