const express = require('express');
const app = express();
const PORT = process.env.NODE_PORT || 3000;

// ==========================================
// 路由 1：动态解析并重写 m3u8
// ==========================================
app.get('/play', async (req, res) => {
  const streamId = req.query.id;
  if (!streamId) return res.status(400).send("缺少频道 ID");

  try {
    // 1. 请求接口获取带鉴权的真实 m3u8 链接 (此请求已全自动走 Xray 香港代理)
    const apiRes = await fetch("https://data.stnye.cc/data/stream.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: `id=${streamId}`
    });
    
    const apiData = await apiRes.json();
    if (apiData.status !== "success" || !apiData.content) {
      return res.status(500).send(`获取地址失败: ${JSON.stringify(apiData)}`);
    }

    const realM3u8Url = apiData.content.replace(/\\\//g, "/");

    // 2. 服务端代替用户去请求真实的 m3u8 文本内容 (走 Xray 香港代理)
    const m3u8Res = await fetch(realM3u8Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (!m3u8Res.ok) {
      return res.status(m3u8Res.status).send(`原服务器拒绝访问 m3u8: ${m3u8Res.status}`);
    }

    const m3u8Text = await m3u8Res.text();
    const realUrlObj = new URL(realM3u8Url);
    const lines = m3u8Text.split('\n');
    
    // 3. 核心重写：将所有视频切片地址转换为以斜杠 / 开头的绝对根路径
    const rewrittenLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      
      let tsUrlObj;
      if (trimmed.startsWith('http')) {
        try {
          tsUrlObj = new URL(trimmed);
        } catch (e) {
          return line;
        }
      } else {
        tsUrlObj = new URL(trimmed, realM3u8Url);
      }

      let search = tsUrlObj.search;
      if (realUrlObj.search && !search) {
        search = realUrlObj.search;
      }

      // 返回如 /livestream/hls/xxx/0.ts?md5=... 
      // 用户的播放器拿到后，会自动向你部署的 Nginx 服务器请求该路径
      return tsUrlObj.pathname + search;
    });

    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    res.send(rewrittenLines.join('\n'));

  } catch (err) {
    res.status(500).send(`代理解析失败: ${err.message}`);
  }
});

// ==========================================
// 路由 2：终极武器！Node.js 代理转发 .ts 视频流出站
// 强制让 Nginx 无法接管的流量全部走 Xray 代理，解决 403 锁 IP
// ==========================================
app.get('/livestream/*', async (req, res) => {
  // 还原目标原平台完整的 TS 切片 URL
  const targetUrl = `https://elive.mayizhibo.net${req.originalUrl}`;

  try {
    // 远程请求切片 (此请求会被系统的 HTTP_PROXY 环境变量强制送入 Xray 隧道)
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://elive.mayizhibo.net/"
      }
    });

    if (!response.ok) {
      return res.status(response.status).send("原平台拒绝提供视频切片");
    }

    // 复制原平台的响应头（Content-Type, Content-Length 等）
    res.set({
      'Content-Type': response.headers.get('content-type') || 'video/MP2T',
      'Content-Length': response.headers.get('content-length'),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    });

    // 真正的全量流媒体管道中转：将原平台返回的数据流，实时同步泵回给客户端播放器
    const reader = response.body.getReader();
    
    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) {
          res.end();
          return;
        }
        res.write(Buffer.from(value));
        return pump();
      });
    }
    
    return pump();

  } catch (err) {
    res.status(500).send(`视频流中转失败: ${err.message}`);
  }
});

// ==========================================
// 路由 3：生成 M3U 列表 与 TXT 列表
// ==========================================
async function getLiveStreams() {
  const eventsResponse = await fetch("https://api.sportlive.cc/data/events.json", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  const eventsData = await eventsResponse.json();
  const liveStreams = [];

  if (eventsData.events && Array.isArray(eventsData.events)) {
    for (const event of eventsData.events) {
      if (event.channels && Array.isArray(event.channels)) {
        for (const channel of event.channels) {
          if (channel.islive === 1) {
            liveStreams.push({
              title: (event.title || "未知赛事").replace(/\s+/g, "_"),
              competition: event.competition || "常规赛",
              lang: channel.islg || "原音",
              hd: channel.ishd || "HD",
              id: channel.id
            });
          }
        }
      }
    }
  }
  return liveStreams;
}

app.get('/m3u', async (req, res) => {
  try {
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const liveStreams = await getLiveStreams();
    let m3uContent = "#EXTM3U\n";
    liveStreams.forEach((r) => {
      const channelName = `${r.competition}_${r.title}_${r.lang}_${r.hd}`;
      const playUrl = `${protocol}://${host}/play?id=${r.id}`;
      m3uContent += `#EXTINF:-1 tvg-name="${channelName}" tvg-id="${channelName}" group-title="职球圈",${channelName}\n${playUrl}\n`;
    });
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.send(m3uContent.trim());
  } catch (err) {
    res.status(500).send(`生成列表失败: ${err.message}`);
  }
});

app.get('/txt', async (req, res) => {
  try {
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const liveStreams = await getLiveStreams();
    let txtContent = "职球圈,#genre#\n";
    liveStreams.forEach((r) => {
      const channelName = `${r.competition}_${r.title}_${r.lang}_${r.hd}`;
      const playUrl = `${protocol}://${host}/play?id=${r.id}`;
      txtContent += `${channelName},${playUrl}\n`;
    });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(txtContent.trim());
  } catch (err) {
    res.status(500).send(`生成列表失败: ${err.message}`);
  }
});

app.use((req, res) => res.status(404).send("请访问 /m3u 或 /txt 获取直播源"));

app.listen(PORT, () => console.log(`Backend proxy manager running on port ${PORT}`));
