/**
 * CherryAI 签名密钥提取器
 *
 * 从本地安装的 Cherry Studio 打包产物 (app.asar -> out/main/main.js) 中
 * 提取完整的 HMAC-SHA256 签名密钥。
 *
 * 打包后的 main.js 内联了生成完整密钥的函数：
 *
 *   var CLIENT_SECRET;                     // 运行时被赋值
 *   function getClientSecret() {
 *     return CLIENT_SECRET + ".GvI6...fixed-suffix";
 *   }
 *   // init 时:
 *   CLIENT_SECRET = "K3RN...prefix";
 *   CLIENT_ID = "cherry-studio";
 *
 * 完整密钥 = prefix + "." + fixedSuffix
 *
 * 本模块通过正则把两部分抓出来再拼接，不硬编码密钥本身，
 * 因此对官方 Release 版本更新也足够健壮（后缀/前缀变了也能自动适配）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_APP_PATHS = [
  '/Applications/Cherry Studio.app',
  path.join(os.homedir(), 'Applications', 'Cherry Studio.app'),
]

const ASAR_REL = path.join('Contents', 'Resources', 'app.asar')
const WORK_DIR = path.join(__dirname, 'extracted-main')

/** 定位 app.asar 绝对路径 */
function findAsar() {
  for (const app of DEFAULT_APP_PATHS) {
    const asar = path.join(app, ASAR_REL)
    if (fs.existsSync(asar)) return asar
  }
  // 也允许通过环境变量覆盖
  if (process.env.CHERRY_STUDIO_APP) {
    const asar = path.join(process.env.CHERRY_STUDIO_APP, ASAR_REL)
    if (fs.existsSync(asar)) return asar
  }
  throw new Error('未找到 Cherry Studio app.asar，请设置 CHERRY_STUDIO_APP 指向 .app 目录')
}

/** 用 @electron/asar 提取整个包到指定目录，返回 main.js 路径 */
export function extractMainJsFromAsar(asarPath, outDir) {
  const mainJs = path.join(outDir, 'content', 'out', 'main', 'main.js')
  if (fs.existsSync(mainJs)) return mainJs

  fs.mkdirSync(outDir, { recursive: true })
  const out = spawnSync(
    'npx', ['--yes', '@electron/asar', 'extract', asarPath, path.join(outDir, 'content')],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 },
  )
  if (out.status !== 0) {
    throw new Error(`asar 提取失败: ${out.stderr || out.stdout}`)
  }
  if (!fs.existsSync(mainJs)) {
    throw new Error('提取成功但未找到 main.js 于 ' + mainJs)
  }
  return mainJs
}

/** 从 main.js 源码提取 { prefix, suffix, clientId, baseUrl } */
export function parseSecret(mainJs) {
  const src = fs.readFileSync(mainJs, 'utf8')

  // init 时赋值的 CLIENT_SECRET = "..."
  const prefixMatch = src.match(/CLIENT_SECRET\s*=\s*"([A-Za-z0-9+/=_-]+)"/)
  if (!prefixMatch) throw new Error('未在 main.js 中找到 CLIENT_SECRET 前缀')
  const prefixAt = prefixMatch.index

  // getClientSecret() { return CLIENT_SECRET + ".<suffix>"; }
  const suffixMatch = src.match(
    /getClientSecret\(\)\s*\{\s*return\s+CLIENT_SECRET\s*\+\s*"(\.?[A-Za-z0-9+/=_-]+)"\s*;?/,
  )
  if (!suffixMatch) throw new Error('未在 main.js 中找到固定后缀')

  // cherryai 的 clientId 与 CLIENT_SECRET 赋值位于同一 init 块，
  // 直接紧跟其后，取紧随其二者的最近一个 CLIENT_ID 赋值。
  const nearId = src.slice(prefixAt, prefixAt + 600).match(/CLIENT_ID\s*=\s*"([^"]+)"/)
  const clientId = nearId ? nearId[1] : 'cherry-studio'
  const baseUrlMatch = src.match(/CHERRYAI_API_BASE_URL\s*=\s*"([^"]+)"/)

  const prefix = prefixMatch[1]
  const suffix = suffixMatch[1].startsWith('.') ? suffixMatch[1] : '.' + suffixMatch[1]
  const fullSecret = prefix + suffix

  return {
    prefix,
    suffix,
    fullSecret,
    clientId,
    baseUrl: baseUrlMatch ? baseUrlMatch[1] : 'https://api.cherry-ai.com',
  }
}

/** 直接取 bytes 文件指纹，便于核对版本… 此处仅对 key 做掩码日志 */
function mask(s) {
  return s.slice(0, 6) + '…' + s.slice(-6) + ` (len=${s.length})`
}

/** 主入口：返回完整密钥结构与 main.js 指纹 */
export function extractCherryAISecret() {
  const asar = findAsar()
  const mainJs = extractMainJsFromAsar(asar, WORK_DIR)
  const secret = parseSecret(mainJs)
  console.log(`[extract] asar   : ${asar}`)
  console.log(`[extract] main.js: ${mainJs}`)
  console.log(`[extract] clientId   : ${secret.clientId}`)
  console.log(`[extract] baseUrl    : ${secret.baseUrl}`)
  console.log(`[extract] prefix     : ${mask(secret.prefix)}`)
  console.log(`[extract] suffix     : ${mask(secret.suffix)}`)
  console.log(`[extract] fullSecret : ${mask(secret.fullSecret)}`)
  return secret
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  extractCherryAISecret()
}
