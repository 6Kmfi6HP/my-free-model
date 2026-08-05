/**
 * CherryAI 免费模型 —— 真实请求 prototype
 *
 * 流程：
 *   1. 从本地安装的 Cherry Studio 自动提取完整 HMAC 签名密钥
 *   2. 复现其签名算法（POST / path / query / clientId / timestamp / body，HMAC-SHA256 hex）
 *   3. 向 https://api.cherry-ai.com/chat/completions 发送真实请求
 *   4. 打印 AI 回复（支持流式 / 非流式）
 *
 * 用法：
 *   node cherryai-request.js "你好"            # 非流式
 *   node cherryai-request.js --stream "你好"   # 流式
 */
import { createHmac } from 'node:crypto'
import { extractCherryAISecret } from './cherryai-secret.js'

export function buildSignature(secret, { method, pathUrl, query = '', body }) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const canonical = [
    method.toUpperCase(),
    pathUrl,
    query,
    secret.clientId,
    timestamp,
    bodyString,
  ].join('\n')
  const signature = createHmac('sha256', secret.fullSecret)
    .update(canonical)
    .digest('hex')
  return {
    'X-Client-ID': secret.clientId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const stream = argv.includes('--stream')
  const prompt = argv.filter((a) => a !== '--stream').join(' ') || '你好'

  // 1) 提取密钥
  const secret = extractCherryAISecret()

  const baseUrl = secret.baseUrl
  const pathUrl = '/chat/completions'
  const url = baseUrl + pathUrl

  const body = {
    model: 'qwen',
    messages: [{ role: 'user', content: prompt }],
    stream,
  }

  // 2) 签名与请求体必须使用完全相同的 JSON 字符串
  const bodyString = JSON.stringify(body)
  const headers = buildSignature(secret, { method: 'POST', pathUrl, body: bodyString })
  headers['Content-Type'] = 'application/json'
  headers['HTTP-Referer'] = 'https://cherry-ai.com'
  headers['X-Title'] = 'Cherry Studio'

  console.log(`\n[req] POST ${url}`)
  console.log(`[req] prompt : ${prompt}`)
  console.log(`[req] headers: ${JSON.stringify(headers, null, 2)}\n`)

  // 3) 发送
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyString,
  })

  console.log(`[resp] HTTP ${res.status} ${res.statusText}`)

  if (!res.ok) {
    const text = await res.text()
    console.error('[resp] 请求失败：')
    console.error(text)
    process.exit(1)
  }

  // 4) 输出
  if (stream) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      // 逐行解析 SSE
      let idx
      while ((idx = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, idx).trim()
        acc = acc.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload)
          const delta = j.choices?.[0]?.delta?.content
          if (delta) process.stdout.write(delta)
        } catch { /* 忽略不完整/非 JSON 事件 */ }
      }
    }
    console.log('\n')
  } else {
    const j = await res.json()
    const content = j.choices?.[0]?.message?.content
    console.log('\n[reply]\n' + (content ?? JSON.stringify(j, null, 2)))
  }
}

main().catch((e) => {
  console.error('[fatal]', e.message)
  process.exit(1)
})
