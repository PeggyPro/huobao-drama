import { fileURLToPath } from 'node:url'

// —— 网络访问配置 ——
// 开发服务器默认监听 0.0.0.0：局域网 IP、内网域名、反向代理、内网穿透都能访问，
// 不再只有 localhost:3013 可用。只想本机访问时设 NUXT_HOST=localhost。
const devHost = process.env.NUXT_HOST || '0.0.0.0'
const devPort = Number(process.env.NUXT_PORT || 3013)

// 后端地址：默认本机 5679（Vite 代理在服务端转发，浏览器侧始终同源）。
// 前后端不在同一台机器/容器时，用 HUOBAO_API_ORIGIN 指向真正的后端。
const apiOrigin = (process.env.HUOBAO_API_ORIGIN || 'http://localhost:5679').replace(/\/+$/, '')

export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  devtools: { enabled: false },
  // 监听所有网卡（0.0.0.0）；缺省时 Nuxt 只绑 localhost 并提示 "use --host to expose"
  devServer: {
    host: devHost,
    port: devPort,
  },
  experimental: {
    appManifest: false,
  },
  hooks: {
    // 动态路由页面统一放在 app/views/ 手动注册，避免文件路径中出现 [id] 方括号
    // （方括号路径在 git/shell 中需转义，且部分部署环境不兼容）。URL 保持不变。
    'pages:extend'(pages) {
      pages.push(
        {
          name: 'drama-detail',
          path: '/drama/:id',
          file: fileURLToPath(new URL('./app/views/drama/detail.vue', import.meta.url)),
        },
        {
          name: 'drama-episode',
          path: '/drama/:id/episode/:episodeNumber',
          file: fileURLToPath(new URL('./app/views/drama/episode.vue', import.meta.url)),
        },
      )
    },
  },
  app: {
    head: {
      title: '火宝短剧',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        // v 参数用于 favicon 缓存穿透（浏览器对 favicon 缓存独立于 HTTP 缓存，换图必须 bump）
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon.png?v=20261002' },
        { rel: 'shortcut icon', type: 'image/png', href: '/favicon.png?v=20261002' },
      ],
    },
  },
  vite: {
    server: {
      // 关闭 Vite 的 Host 头校验（DNS 重绑定保护）：允许用局域网域名 / 内网穿透域名
      // （如 huobao.local、xxx.ngrok.io）访问，否则 dev server 会返回
      // "Blocked request. This host is not allowed."。IP 直连不受影响。
      allowedHosts: true,
      proxy: {
        '/api': { target: apiOrigin, changeOrigin: true },
        '/static': { target: apiOrigin, changeOrigin: true },
      },
    },
  },
  compatibilityDate: '2025-05-15',
})
