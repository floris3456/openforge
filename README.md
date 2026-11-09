<p align="center"><b>openforge</b></p>
<p align="center">An open source AI coding agent for the terminal, built on opencode, with CLIProxyPacer built in.</p>
<p align="center">
  <a href="https://github.com/floris3456/openforge/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/floris3456/openforge?style=flat-square" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/floris3456/openforge?style=flat-square" /></a>
</p>

```text
█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀▀ █▀▀█ █▀▀█
█  █ █  █ █▀▀▀ █  █ █▀▀  █  █ █    █  █ █▀▀▀
▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀    ▀▀▀▀ ▀    ▀▀▀█ ▀▀▀▀
```

openforge is a fork of [opencode](https://github.com/anomalyco/opencode) v2. It keeps opencode's terminal
interface, agents, tools and providers, and adds:

- **CLIProxyPacer, built in.** Connect your CLIProxyPacer and its models are openforge's: usage meters of the
  accounts serving the chat's model in the sidebar, the prompt cache's countdown and keep-alive in the toolbar, a
  notice when a request missed the cache, compaction before a large chat's cache goes cold (with summaries
  CLIProxyPacer writes where it can), its web search and fetch tools, and every request of a chat in a **Requests**
  tab.
- **Upgrades while agents run.** `openforge upgrade` installs the new release beside the running one and switches
  without stopping your chats: replies carry on, running commands keep their output, and a failed switch goes back
  to the release before.
- **One background service** for all your terminals, which the TUI starts when none runs (`openforge service`), or a
  private one with `--standalone`.
- **Notifications over ssh.** `openforge notify` plays your chats' sounds on the machine you sit at, also while
  openforge runs on another one; `openforge notify … --install` keeps it running as a service of that machine.

Releases are early and frequent. openforge is built for **Linux x64** and **macOS on Apple silicon**.

## Install

```sh
curl -fsSL https://github.com/floris3456/openforge/releases/latest/download/install.sh | sh
```

A given version: `curl -fsSL https://github.com/floris3456/openforge/releases/latest/download/install.sh | sh -s -- 0.0.12`.

The script downloads the release for your platform from
[GitHub Releases](https://github.com/floris3456/openforge/releases), checks its SHA-256 against the release's
`SHA256SUMS`, and installs it as:

```text
~/.local/share/openforge/releases/<version>/openforge   (or under $XDG_DATA_HOME)
~/.local/share/openforge/current -> releases/<version>
~/.local/bin/openforge -> ~/.local/share/openforge/current/openforge
```

It tells you when `~/.local/bin` is not on your `PATH`. Nothing else is changed, and nothing needs `sudo`.

### Manual installation

The same steps by hand, in the layout `openforge upgrade` keeps. Set your platform and the version first (the latest
is on the [releases page](https://github.com/floris3456/openforge/releases/latest)):

```sh
P=linux-x64          # or darwin-arm64 on a Mac
V=0.0.12             # the version, without the v
U=https://github.com/floris3456/openforge/releases/download/v$V

curl -fLO $U/openforge-$P.tar.gz
curl -fLO $U/SHA256SUMS
grep " openforge-$P.tar.gz\$" SHA256SUMS | sha256sum -c -        # on a Mac: shasum -a 256 -c -

D=${XDG_DATA_HOME:-$HOME/.local/share}/openforge
mkdir -p "$D/releases/$V" ~/.local/bin
tar -xzf openforge-$P.tar.gz -C "$D/releases/$V"
ln -sfn "releases/$V" "$D/current"
ln -sfn "$D/current/openforge" ~/.local/bin/openforge
~/.local/bin/openforge --version
```

The check prints `openforge-<platform>.tar.gz: OK`, and the last command `openforge v<version>`. On a Mac, an archive
downloaded with a browser instead of `curl` is quarantined, and macOS may refuse to run what it holds:
`xattr -dr com.apple.quarantine "$D/releases/$V"` lifts that.

### Upgrade and uninstall

```sh
openforge upgrade            # to the latest release, while your chats run
openforge upgrade 0.0.11     # to a given version, kept or downloaded
openforge uninstall          # keeps your sessions, configuration and state
```

## Get started

```sh
cd your-project
openforge                              # the terminal interface
openforge auth login                   # connect a provider
openforge auth login cliproxypacer     # connect CLIProxyPacer: it asks for its address and your client key
openforge run "explain this codebase"  # one message, without the interface
```

Two agents come built in; `Tab` switches between them:

- **build**, the default: full access, for development work;
- **plan**: read-only, for exploring and planning; it asks before running commands and edits no files.

A **general** subagent handles longer searches and tasks; mention it with `@general`.

## Documentation

openforge's own documentation is in [`services/www/src/docs/content`](services/www/src/docs/content), among it
[CLIProxyPacer in the TUI](services/www/src/docs/content/cli/cliproxypacer.mdx) and
[providers](services/www/src/docs/content/providers.mdx). For what openforge shares with opencode,
[opencode's documentation](https://opencode.ai/v2/docs) applies, with `openforge` in place of `opencode`.

## About

openforge is not built by the opencode team and is not affiliated with it. It started at opencode v2.2.5 and takes
in opencode's releases as they come. [MIT license](LICENSE), as opencode.
