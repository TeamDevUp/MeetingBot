const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const fs = require('fs');
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
  'weekly':    { name: '주간 회의',     parentId: '7405577'  },
  'ios':       { name: 'iOS 회의록',   parentId: '4751381'  },
  'external':  { name: '외부 미팅',    parentId: '12976132' },
  'milestone': { name: '마일스톤 회고', parentId: '19726353' },
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

process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e));

// ─── 버튼 UI ───────────────────────────────────────────────

function buildMeetingButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('meeting_weekly')   .setLabel('주간 회의')     .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('meeting_ios')      .setLabel('iOS 회의록')   .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('meeting_external') .setLabel('외부 미팅')    .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('meeting_milestone').setLabel('마일스톤 회고').setStyle(ButtonStyle.Secondary),
  );
  return row;
}

// ─── VITO API ──────────────────────────────────────────────

async function getVitoToken() {
  const res = await axios.post(
    'https://openapi.vito.ai/v1/authenticate',
    new URLSearchParams({ client_id: VITO_CLIENT_ID, client_secret: VITO_CLIENT_SECRET }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data.access_token;
}

async function submitVitoTranscribe(wavPath, token) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(wavPath));
  form.append('config', JSON.stringify({ diarization: { use_verification: false }, use_multi_channel: false }));
  const res = await axios.post('https://openapi.vito.ai/v1/transcribe', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
  });
  return res.data.id;
}

async function pollVitoResult(transcribeId, token) {
  const url = `https://openapi.vito.ai/v1/transcribe/${transcribeId}`;
  while (true) {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    const { status, results } = res.data;
    if (status === 'completed') return results.utterances.map(u => u.msg).join(' ');
    if (status === 'failed') throw new Error('VITO 변환 실패');
    await new Promise(r => setTimeout(r, 3000));
  }
}

function pcmFileToWav(pcmPath, wavPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmPath, '-y', wavPath]);
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg 오류: ${code}`)));
  });
}

async function transcribeWithVito(pcmPath) {
  const wavPath = `/tmp/meeting_${Date.now()}.wav`;
  try {
    await pcmFileToWav(pcmPath, wavPath);
    const token = await getVitoToken();
    const id = await submitVitoTranscribe(wavPath, token);
    return await pollVitoResult(id, token);
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
    if (line.startsWith('# '))        { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h1>${line.slice(2)}</h1>`); }
    else if (line.startsWith('## '))  { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h2>${line.slice(3)}</h2>`); }
    else if (line.startsWith('### ')) { if (inList) { html.push('</ul>'); inList = false; } html.push(`<h3>${line.slice(4)}</h3>`); }
    else if (line.startsWith('- '))   { if (!inList) { html.push('<ul>'); inList = true; } html.push(`<li>${line.slice(2)}</li>`); }
    else if (line.trim() === '')      { if (inList) { html.push('</ul>'); inList = false; } html.push('<p></p>'); }
    else                              { if (inList) { html.push('</ul>'); inList = false; } html.push(`<p>${line}</p>`); }
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
  const existing = await findExistingPage(title);
  if (existing) {
    const now = new Date();
    title = `${title} (${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')})`;
  }
  const res = await axios.post(`${CONFLUENCE_URL}/wiki/rest/api/content`, {
    type: 'page', title,
    space: { key: CONFLUENCE_SPACE_KEY },
    ancestors: [{ id: parentId }],
    body: { storage: { value: markdownToConfluence(content), representation: 'storage' } },
  }, { headers });
  return res.data._links?.webui ? `${CONFLUENCE_URL}/wiki${res.data._links.webui}` : CONFLUENCE_URL;
}

// ─── Claude 회의록 생성 ────────────────────────────────────

async function generateMinutes(transcript, participants, meetingType) {
  const now = new Date();
  const today = `${now.getFullYear()}년 ${String(now.getMonth()+1).padStart(2,'0')}월 ${String(now.getDate()).padStart(2,'0')}일`;
  const todayTitle = now.toISOString().slice(0, 10);
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: `다음은 오늘(${today}) ${meetingType.name} 내용입니다.\n참여자: ${participants}\n\n[회의 내용]\n${transcript}\n\n위 내용을 바탕으로 아래 형식에 맞게 회의록을 작성해주세요. 형식을 절대 변경하지 마세요.\n\n# ${todayTitle} 회의록\n\n## 날짜\n${today}\n\n## 참여자\n${participants || '[확인 필요]'}\n\n## 목표\n(회의 목표를 한 줄로 요약)\n\n## 자료\n(회의에서 언급된 링크나 자료. 없으면 -)\n\n## 토론 주제\n| 시간 | 토픽 | 발표자 | 비고 |\n|------|------|--------|------|\n(각 토론 주제별로 한 행씩. 비고에 주요 내용, 질답, 결정사항 상세 기록)\n\n## 조치 항목\n| 담당자 | 내용 | 기한 |\n|--------|------|------|\n\n## 결정 사항\n(최종 결정된 내용)\n\n## 관련 정보\n(참고 링크, 문서 등. 없으면 -)\n\n불명확한 부분은 [확인 필요]로 표시해주세요.` }],
  });
  return { minutes: res.content[0].text, todayTitle };
}

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

async function processRecording(channel, pcmPath, participants, meetingType) {
  await channel.send('🎙️ 음성을 텍스트로 변환 중... (VITO STT)');
  if (!fs.existsSync(pcmPath) || fs.statSync(pcmPath).size === 0) {
    await channel.send('⚠️ 녹음된 데이터가 없어요.');
    try { fs.unlinkSync(pcmPath); } catch {}
    return;
  }
  try {
    const transcript = await transcribeWithVito(pcmPath);
    if (!transcript.trim()) { await channel.send('⚠️ 음성 변환 결과가 없어요.'); return; }
    await channel.send(`✅ 변환 완료!\n\`\`\`\n${transcript.slice(0, 300)}${transcript.length > 300 ? '...' : ''}\n\`\`\``);
    await channel.send('📝 회의록 생성 중...');
    const { minutes, todayTitle } = await generateMinutes(transcript, participants.join(', '), meetingType);
    await finishAndUpload(channel, minutes, todayTitle, meetingType);
  } catch (e) {
    console.error('처리 오류:', e.message);
    await channel.send(`⚠️ 처리 중 오류가 발생했어요: ${e.message}`);
  } finally {
    try { fs.unlinkSync(pcmPath); } catch {}
  }
}

// ─── 유저 스트림 구독 ──────────────────────────────────────

function subscribeUser(receiver, userId, pcmWriteStream, userStreams) {
  if (userStreams.subscribed.has(userId)) return;
  userStreams.subscribed.add(userId);
  const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 2000 } });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  opusStream.pipe(decoder);
  decoder.on('data', chunk => pcmWriteStream.write(chunk));
  decoder.on('end', () => userStreams.subscribed.delete(userId));
  decoder.on('error', e => console.error('Decoder 오류:', e.message));
}

// ─── 녹음 시작 공통 함수 ───────────────────────────────────

async function startRecording(interaction, voiceChannel, meetingType, channel) {
  const participants = voiceChannel.members.map(m => m.displayName);
  const guildId = voiceChannel.guild.id;

  if (recordingSessions.has(guildId)) {
    await interaction.reply({ content: '⚠️ 이미 녹음 중이에요!', ephemeral: true });
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (e) {
    connection.destroy();
    await interaction.reply({ content: '❌ 음성 채널 연결 실패! 다시 시도해주세요.', ephemeral: true });
    return;
  }

  const pcmPath = `/tmp/meeting_${Date.now()}.pcm`;
  const pcmWriteStream = fs.createWriteStream(pcmPath);
  const userStreams = { subscribed: new Set() };
  const receiver = connection.receiver;
  receiver.speaking.on('start', userId => subscribeUser(receiver, userId, pcmWriteStream, userStreams));

  recordingSessions.set(guildId, { connection, pcmWriteStream, pcmPath, meetingType, participants, channel });

  await interaction.update({
    content: `🔴 **${meetingType.name} 녹음 시작!**\n참여자: ${participants.join(', ')}\n종료: \`!종료\``,
    components: [],
  });
}

// ─── Discord 이벤트 ────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`✅ ${client.user.tag} 봇 시작됨!`);
});

// 버튼 클릭 처리
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('meeting_')) return;

  const key = interaction.customId.replace('meeting_', '');
  const meetingType = MEETING_TYPES[key];
  if (!meetingType) return;

  const member = interaction.member;
  if (!member?.voice?.channel) {
    await interaction.reply({ content: '❌ 먼저 음성 채널에 들어가 주세요!', ephemeral: true });
    return;
  }

  await startRecording(interaction, member.voice.channel, meetingType, interaction.channel);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const channelId = message.channelId;

  // 회의 유형 선택 대기 (텍스트 방식 !회의록용)
  if (pendingMinutes.has(channelId)) {
    const key = { '1': 'weekly', '2': 'ios', '3': 'external', '4': 'milestone' }[message.content];
    if (key) {
      const meetingType = MEETING_TYPES[key];
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

  // !시작 → 버튼 표시
  if (message.content === '!시작') {
    if (!message.member?.voice?.channel) {
      await message.channel.send('❌ 먼저 음성 채널에 들어가 주세요!');
      return;
    }
    if (recordingSessions.has(message.guildId)) {
      await message.channel.send('⚠️ 이미 녹음 중이에요!');
      return;
    }
    await message.channel.send({
      content: '📂 **어떤 회의를 시작할까요?**',
      components: [buildMeetingButtons()],
    });

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
    session.pcmWriteStream.end(() => {
      message.channel.send('⏹️ 녹음 종료! 처리 중...');
      processRecording(session.channel, session.pcmPath, session.participants, session.meetingType);
    });

  // !회의록
  } else if (message.content.startsWith('!회의록')) {
    const content = message.content.replace('!회의록', '').trim();
    if (!content) {
      await message.channel.send('📋 **사용법**\n```\n!회의록 [회의 내용]\n```');
      return;
    }
    let participants = '';
    if (message.member?.voice?.channel) {
      participants = message.member.voice.channel.members.map(m => m.displayName).join(', ');
    }
    pendingMinutes.set(channelId, { content, participants });
    await message.channel.send({
      content: '📂 **어떤 회의인가요?**',
      components: [buildMeetingButtons()],
    });

  // !도움말
  } else if (message.content === '!도움말') {
    await message.channel.send('📋 **회의록 봇 사용법**\n\n**🎙️ 음성 녹음 방식**\n`!시작` — 버튼으로 회의 유형 선택 후 녹음 시작\n`!종료` — 녹음 종료 → VITO STT → 회의록 → Confluence\n\n**📝 텍스트 입력 방식**\n`!회의록 [내용]` — 텍스트로 회의록 생성');
  }
});

client.login(DISCORD_TOKEN);
