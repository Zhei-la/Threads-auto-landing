const https = require('https');
const fs = require('fs');
const path = require('path');

const SKIP = ['node_modules', '.git', 'dist', 'build'];
const EXT = ['.js', '.ts', '.py', '.html', '.json'];

function collect(dir, out = []) {
  try {
    fs.readdirSync(dir).forEach(e => {
      if (SKIP.includes(e)) return;
      const f = path.join(dir, e);
      try {
        const s = fs.statSync(f);
        if (s.isDirectory()) collect(f, out);
        else if (EXT.some(x => f.endsWith(x))) out.push(f);
      } catch {}
    });
  } catch {}
  return out;
}

let code = '';
for (const f of collect('.')) {
  try {
    code += '\n--- ' + f + ' ---\n' + fs.readFileSync(f, 'utf8');
    if (code.length > 8000) { code = code.slice(0, 8000) + '...'; break; }
  } catch {}
}

function post(hostname, p, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: p, method: 'POST', headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON 파싱 실패: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const prompt = `당신은 웹 보안 전문가입니다. 아래 코드를 분석해서 보안 취약점을 찾아주세요.

코드:
${code}

반드시 아래 JSON 형식으로만 응답하세요. 마크다운 없이 JSON만:
{
  "overall": "safe 또는 warning 또는 danger 중 하나",
  "summary": "전체 요약 한두문장",
  "critical": [
    {"title": "취약점 제목", "detail": "상세 설명", "fix": "수정 방법"}
  ],
  "warning": [
    {"title": "경고 제목", "detail": "상세 설명", "fix": "수정 방법"}
  ],
  "passed": ["안전한 항목1", "안전한 항목2"]
}`;

    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const r = await post('api.openai.com', '/v1/chat/completions', body, {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Length': Buffer.byteLength(body)
    });

    const text = r.choices[0].message.content.replace(/```json|```/g, '').trim();
    const j = JSON.parse(text);

    if (j.critical) j.critical = j.critical.map(i => ({
      title: i.title || '항목',
      detail: i.detail || i.description || i.issue || '',
      fix: i.fix || i.recommendation || i.solution || ''
    }));
    if (j.warning) j.warning = j.warning.map(i => ({
      title: i.title || '항목',
      detail: i.detail || i.description || i.issue || '',
      fix: i.fix || i.recommendation || i.solution || ''
    }));

    const e = j.overall === 'danger' ? '🚨' : j.overall === 'warning' ? '⚠️' : '✅';
    const color = j.overall === 'danger' ? 0xE24B4A : j.overall === 'warning' ? 0xEF9F27 : 0x639922;
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    const fields = [];
    if (j.critical && j.critical.length) fields.push({
      name: '🚨 위험',
      value: j.critical.map(i => `**${i.title}**\n${i.detail}\n수정: ${i.fix}`).join('\n\n').slice(0, 900)
    });
    if (j.warning && j.warning.length) fields.push({
      name: '⚠️ 경고',
      value: j.warning.map(i => `**${i.title}**\n${i.detail}\n수정: ${i.fix}`).join('\n\n').slice(0, 900)
    });
    if (j.passed && j.passed.length) fields.push({
      name: '✅ 안전',
      value: j.passed.map(p => '• ' + p).join('\n').slice(0, 500)
    });

    const wb = JSON.stringify({
      embeds: [{
        title: `${e} 보안점검 - ${process.env.REPO_NAME}`,
        description: j.summary,
        color,
        fields,
        footer: { text: '점검: ' + now }
      }]
    });

    const u = new URL(process.env.DISCORD_WEBHOOK);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wb) }
      }, res => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', reject);
      req.write(wb);
      req.end();
    });

    console.log('✅ 디스코드 전송 완료');
  } catch(e) {
    console.error('오류:', e.message);
    process.exit(1);
  }
})();
