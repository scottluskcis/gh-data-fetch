# Development environment

The repository includes a VS Code Dev Container with Node.js, TypeScript, the
GitHub CLI, and the 1Password CLI (`op`) preinstalled.

## Setup

1. Open the repository in the Dev Container.
2. Confirm that the required tools are available:

   ```bash
   node --version
   pnpm --version
   op --version
   ```

3. Install dependencies:

   ```bash
   pnpm install
   ```

The scoped `@scottluskcis` dependency is downloaded from GitHub Packages, so
`GITHUB_TOKEN` must be available and authorized to read that package.

## Authenticate with 1Password

Varlock supports either a scoped service account or an interactive 1Password
user session. Prefer a service account when one is available because it can be
limited to only the vaults required by this project.

### Service account

Add the service account token to the local `.env` file:

```dotenv
OP_TOKEN=ops_your_service_account_token
```

Use the complete token issued by 1Password in place of the example value.
This repository ignores `.env`, and the file must remain untracked. Do not put
the token in `.env.schema`, commit it, paste it into documentation, or expose
it in terminal output.

The variable is named `OP_TOKEN` because `.env.schema` passes it to the
1Password plugin:

```dotenv
# @initOp(token=$OP_TOKEN, allowAppAuth=forEnv(development), account=github)
```

Confirm that Varlock can load the environment, then run the application:

```bash
pnpm env:load
pnpm dev
```

The service account must have read access to every vault referenced by the
project's `op://` values. It cannot access vaults that were not granted when
the service account was created.

For a temporary session that does not store the token in `.env`, enter it
without adding it to shell history:

```bash
read -rsp "1Password service account token: " OP_TOKEN
echo
export OP_TOKEN
pnpm dev
unset OP_TOKEN
```

### Interactive user account

Local development does not require a service account. When `OP_TOKEN` is
empty, the Varlock configuration permits interactive CLI authentication when
`APP_ENV=development`, which is the default environment.

Because `op` runs inside the container, add and sign in to your 1Password
account from the container terminal:

```bash
op account add --shorthand github
eval "$(op signin --account github)"
op whoami --account github
```

The account shorthand must be `github` because `.env.schema` configures
Varlock with `account=github`. When adding the account, `op` prompts for the
organization sign-in address, email address, Secret Key, and account password.
Leave `OP_TOKEN` unset when using your interactive account.

The CLI session expires after 30 minutes of inactivity. Sign in again with:

```bash
eval "$(op signin --account github)"
```

End the session explicitly when finished:

```bash
op signout
```

Manual CLI authentication grants commands in the container access as your
1Password user. Only use a trusted development environment and vaults your
user is authorized to access.

#### Desktop app integration

When running the project directly on your workstation, you can enable
**1Password > Settings > Developer > Integrate with 1Password CLI** and
authenticate through the desktop app. Desktop integration generally does not
pass through automatically to a Dev Container or GitHub Codespace, so use the
manual sign-in flow above inside the container.

## Run the project

```bash
pnpm dev
```

Varlock resolves any configured `op://` secret references at runtime and
injects their values into the application process.

## References

- [1Password manual CLI sign-in](https://www.1password.dev/cli/sign-in-manually)
- [1Password desktop app integration](https://www.1password.dev/cli/app-integration)
- [Varlock 1Password plugin](https://github.com/dmno-dev/varlock/tree/main/packages/plugins/1password)
