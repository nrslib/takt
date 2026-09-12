# Decision Log

## Managed DeepSeek Harness environment

- **Decision**: Build the DeepSeek Harness runtime as a uv project under the global TAKT directory, using uv-managed CPython 3.12, a locked project environment, and the fixed matching SDK/runtime releases shipped with TAKT.
- **Rationale**: A managed environment removes interpreter selection from provider configuration, keeps installation separate from npm lifecycle hooks and normal provider startup, and makes indirect dependency resolution reproducible.
- **Public contract**: `takt deepseek-harness install` is the explicit installation and repair entry point. The provider starts only from the managed absolute interpreter path; `--python`, `--uv-path`, and `provider_options.deepseek_harness.python_path` are not supported.
- **Primary sources**: https://github.com/nrslib/takt/issues/1560; `src/infra/deepseek-harness/pyproject.toml`; `src/infra/deepseek-harness/uv.lock`; https://docs.astral.sh/uv/concepts/projects/sync/; https://docs.astral.sh/uv/concepts/python-versions/; https://docs.astral.sh/uv/concepts/cache/#cache-safety.
