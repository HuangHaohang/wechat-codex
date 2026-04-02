# codex-home

This directory is the project-local `CODEX_HOME` used by `wechat-codex`.

Files intended for source control:

- `config.toml` as the safe template users edit after cloning
- this `README.md`
- this `.gitignore`

Everything else under this directory is runtime state and should stay untracked:

- auth files
- sessions
- sqlite state
- installed skills
- logs
- temporary files
