/** Production environment configuration. */
export const environment = {
  production: true,
  /** Same origin in production — Caddy reverse-proxies /api and /ws */
  apiUrl: '',
  wsUrl: '',
};
