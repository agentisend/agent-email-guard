# Publishing agent-email-guard to PyPI

Nothing here has been run against PyPI. The package was built and checked locally only (`python -m build`, `twine check`). Publishing is a launch-day step, done together with the Node, PHP and Go ports. Every port's 0.1.x passes the 0.1 vectors (SPEC §10).

- PyPI name: `agent-email-guard`. Import name: `agent_email_guard`.
- Version: `pyproject.toml` `version` and `src/agent_email_guard/_version.py` `__version__` must match. Bump both together.
- Account: the owner's PyPI account that published `agentisend` 0.1.0 on 2026-09-30. A new project needs an account-wide token for the first upload. Scope tokens to the project after that.

## 1. Pre-flight (from this directory)

```bash
cd oss/agent-guard/python
uv venv -p 3.9 .venv39 && uv pip install -p .venv39/bin/python -e '.[redis,postgres]' pytest 'fakeredis[lua]' psycopg-binary
.venv39/bin/python -m pytest -q
AGENT_GUARD_TEST_PG='postgresql://USER:PASS@127.0.0.1:55432/agentisend' .venv39/bin/python -m pytest -q tests/test_stores.py
```

All tests pass, including the 45 spec vectors in `tests/test_spec_vectors.py`. The Postgres run creates a throwaway schema and drops it afterwards.

## 2. Build in a scratch venv

```bash
python3 -m venv /tmp/agpub && /tmp/agpub/bin/pip install --upgrade build twine
rm -rf dist && /tmp/agpub/bin/python -m build --outdir dist .
/tmp/agpub/bin/twine check dist/*
```

Expect `dist/agent_email_guard-0.1.0-py3-none-any.whl` and `dist/agent_email_guard-0.1.0.tar.gz`. Both should report `PASSED`.

## 3. Inspect what will be public

```bash
tar tzf dist/agent_email_guard-0.1.0.tar.gz
unzip -l dist/agent_email_guard-0.1.0-py3-none-any.whl
# no secrets, no local paths, no other product names. OTHER_NAMES is a
# "a|b|c" list of the owner's other product names, kept out of this public file:
tar xzf dist/agent_email_guard-0.1.0.tar.gz -O | grep -inE "BEGIN .*PRIVATE|/Users/|as_live_|${OTHER_NAMES:?set OTHER_NAMES}" || echo clean
```

The wheel holds only `agent_email_guard/` (with `py.typed`), plus `LICENSE` and the metadata. The sdist adds `tests/` and `examples/`.

## 4. Upload

Option A, the route used for `agentisend` 0.1.0: twine with a token. The token goes in the environment only, never in a `.pypirc` or a file in the repo.

```bash
# optional dry run against TestPyPI (separate account and token):
TWINE_USERNAME=__token__ TWINE_PASSWORD="$TEST_PYPI_TOKEN" /tmp/agpub/bin/twine upload --repository testpypi dist/*
uv venv -p 3.12 /tmp/agtry && uv pip install -p /tmp/agtry/bin/python --index-url https://test.pypi.org/simple/ agent-email-guard==0.1.0
/tmp/agtry/bin/python -c "import agent_email_guard as g; print(g.__version__, g.REASON_TOKENS)"

# the real upload:
TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_TOKEN" /tmp/agpub/bin/twine upload dist/*
```

To create the token, go to https://pypi.org/manage/account/token/. Before the project exists, the only scope offered is the whole account. After the first upload, create a token scoped to `agent-email-guard` and remove the account-wide one. Removing a token asks for the account password, so the owner does that step.

Option B: trusted publishing from the public repository `github.com/agentisend/agent-email-guard`, once it exists and GitHub Actions minutes are available. On PyPI, go to Your account, then Publishing, then "Add a new pending publisher". Fill in:

| Field | Value |
|---|---|
| PyPI project name | `agent-email-guard` |
| Owner | `agentisend` |
| Repository | `agent-email-guard` |
| Workflow | `publish-python.yml` |
| Environment | `pypi` |

Then add `.github/workflows/publish-python.yml` to that repository:

```yaml
name: publish-python
on:
  push:
    tags: ["python-v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: pypi
    permissions:
      id-token: write
    defaults:
      run:
        working-directory: python
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install build pytest && pip install -e . && pytest -q
      - run: python -m build
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          packages-dir: python/dist
```

Tag `python-v0.1.0` and push the tag. Trusted publishing needs no token.

## 5. After the upload

```bash
uv venv -p 3.9 /tmp/agcheck && uv pip install -p /tmp/agcheck/bin/python agent-email-guard==0.1.0
/tmp/agcheck/bin/python -c "from agent_email_guard import Guard; print(Guard(budgets={'per_day': 1}).check({'to': 'a@example.com'}).reason)"   # ok
```

- https://pypi.org/project/agent-email-guard/ should show the README, the MIT license, and Python 3.9 to 3.13.
- Add the install line to the agent-email-guard landing and docs pages. Ping IndexNow, Search Console, Bing and Brave for any new public page (`publish-page-everywhere`).
- Record the release in `docs/STATUS.md` and the month's `docs/log/`.
