// Audit always seats these three roles, independent of coding mode's member/model overrides.
export function auditConfig(cfg) {
  return { ...cfg, audit: true, implementer: 'claude', members: ['claude', 'codex', 'fx'],
    models: { ...cfg.models, claude: 'opus', fx: 'kimi-k31-pro-abliterated' },
    fxProvider: 'lyber', fxKeyEnv: 'LYBER_API_KEY', orca: { ...cfg.orca, mode: 'off' } }
}
