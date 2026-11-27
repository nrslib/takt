# Worker pools and cloud deployment

[English](./worker-pool.md) | [日本語](./worker-pool.ja.md) | [简体中文](./worker-pool.zh-CN.md)

A worker pool distributes manager goal tasks automatically executed by the daemon between its builtin worker and remote workers on other machines. Manager conversations and assignment decisions stay on the daemon. Workers request work when they have capacity. Repositories share the pool, and both the worker limit and each project's `concurrency` limit apply.

Single-machine usage is unchanged. Without registered remote workers, the builtin worker executes tasks. `takt run`, `takt watch`, and interactive mode keep their existing local execution path; this configuration does not send them to remote workers.

## Transferring code and execution assets

The daemon fixes the task's original SHA and pushes it to origin. The worker retrieves that SHA from origin and receives the task specification, attachments, workflows, facets, and resolved configuration from the daemon. You do not need to place repository-specific TAKT configuration or workflows on each worker manually.

The worker pushes its result to origin and sends run logs and reports to the daemon. The daemon saves completion after receiving the records, fetching the result, and verifying its SHA. A successful connection alone does not mean a task succeeded.

## Preparing the daemon machine

Prepare a cloud instance with Node.js 22.22.0 or later, the intended TAKT version, Git, and the provider and project tools needed by manager and the builtin worker. Configure a Git commit name and email for the execution user. Install SDKs in advance with commands such as `takt install codex`; see [managed SDK installation](./cli-reference.md#managed-sdk-installation-and-updates) for the available targets.

Place the repositories under the daemon user and configure origin. The daemon needs permission to push the original branch and fetch results; workers need permission to fetch code and push result branches. This guide uses an HTTPS origin that accepts a Git token. Do not embed tokens in origin URLs. Provide `gh` and the required permissions when using PR operations.

As the same user, open `takt manager` once in each repository to register it for manager use. Automatic goal-task execution requires `manager.auto_run: true` and runnable pending goal tasks. See [goal management](./goal-management.md) for creating and operating goals. Talk to the cloud manager from a terminal on that instance or through configured Slack integration. The worker endpoint cannot connect a remote TUI or Web UI.

Add the following to the daemon's global `~/.takt/config.yaml`, or `config.yaml` under `TAKT_CONFIG_DIR` if you use a custom directory:

```yaml
daemon:
  builtin_worker:
    concurrency: 1
  remote_worker:
    host: 127.0.0.1
    port: 54322
    credentials:
      git: ${WORKER_GIT_TOKEN}
      gh: ${WORKER_GH_TOKEN}
      providers:
        openai: ${WORKER_OPENAI_KEY}
```

Inject the referenced secrets into the daemon service environment using your cloud's secret management facilities, for example. These names are examples, not environment variable names TAKT reads automatically. Remove entries for credentials you do not need. An empty or unset referenced variable causes credential delivery to fail. Separately make Git, gh, and manager credentials available to the daemon's own execution environment: `credentials` configures distribution to remote tasks.

Keeping the builtin limit at 1 allows PR merge tasks to run. A value of 0 disables both ordinary and merge tasks on the builtin worker, so merge tasks cannot progress. See [daemon configuration](./configuration.md#daemon-worker-pool) for the difference from an omitted limit, supported provider keys, and credential precedence.

## HTTPS and resident startup

The example listener accepts HTTP from a reverse proxy on the same instance. Provide an external URL such as `https://daemon.example.test`, terminating TLS at the reverse proxy or equivalent front end. TAKT does not terminate TLS. Even over a VPN, the worker URL must use HTTPS; plain HTTP is accepted only for localhost.

The front end must stream both the request and response for `POST /worker`. Forward the long-lived HTTP/1.1 NDJSON exchange without waiting to buffer an entire request or response, and configure timeouts to allow long-running connections. Forward the Authorization header without recording its value in access logs. Restrict the internal listener on port 54322 to the required front end. Workers connect outbound and do not need an inbound listening port.

Configure your service manager with the daemon user, a stable HOME and configuration directory, credentials, and PATH. Have it start the following foreground command at OS boot and restart it after unexpected exits:

```sh
takt daemon --resident
```

If a daemon is already running, stop it with `takt daemon stop` before starting it. Restart the same way after configuration changes. `--resident` suppresses automatic exit; it does not register an OS startup service. See the [CLI reference](./cli-reference.md#manager-experimental) for stopping, version mismatches, and ordinary startup's exit conditions.

## Registering and starting workers unattended

Register a worker as the daemon user with the same configuration directory:

```sh
takt worker add cloud-1 --concurrency 2
takt worker list
```

Registration writes the connection token to standard output once. You cannot retrieve it through `list`. Register additional workers under separate names and supply each with its own token. A new connection using the same registration closes the previous connection. The list shows registered names and concurrency, not connection status. See the [worker CLI](./cli-reference.md#worker) for command details.

Prepare a worker image with the same TAKT version as the daemon, Node.js, Git, a Git commit name and email, the SDKs or CLIs for the providers in use, and the project's build and test tools. Include `gh` when PR operations or workflows need it. Use `takt install <provider>` for SDKs and prepare additional tools such as the external OpenCode CLI separately. Executable paths specified by daemon configuration must also be available on workers. Tool binaries are not transferred automatically.

Configure the following script as a cloud startup script or service. The only worker-specific connection settings supplied at startup are the URL and registration token. These variables belong to this script; they are not TAKT environment settings.

```sh
#!/bin/sh
set -eu
: "${WORKER_DAEMON_URL:?Set the daemon HTTPS URL}"
: "${WORKER_REGISTRATION_TOKEN:?Inject the worker registration token}"
exec takt worker --url "$WORKER_DAEMON_URL" --token "$WORKER_REGISTRATION_TOKEN"
```

For example, set the URL to `https://daemon.example.test` and inject the issued token through secret management. If a document or template must show a value, use an obvious fake such as `EXAMPLE_NOT_A_VALID_TOKEN`. Keep real values out of images, Git, startup logs, and shell command tracing. The token is passed as a process argument, so restrict access to the worker environment to trusted users. With the image and startup settings prepared, no login to the worker server is needed after boot.

## Verification and operational limits

Check the worker's startup output for `Worker cloud-1 connected`. Then submit a goal task through manager on the daemon machine and inspect the worker name in the task list, the execution result, and the run logs and reports collected on the daemon. A task may also run on `builtin`. If you temporarily set the builtin limit to 0 to verify remote execution alone, restore it afterward and restart the daemon. PR merge tasks and tasks without origin cannot progress while it is 0.

A disconnected execution can continue on the same worker within the 60-second lease deadline. Expired tasks are recorded as failed, and received records remain available. A failed task reserves one slot on its original worker. Requeue/retry can resume on that worker if its workspace remains. If the registration is removed or a disconnection persists for 60 seconds during retry, execution starts again from the saved original SHA using another worker's capacity. A lost workspace also causes execution to start from the original SHA in a new workspace. In-progress state is not transferred between workers.

To remove a registration, run the following on the daemon machine. A connected worker is disconnected, and further results from that assignment are rejected.

```sh
takt worker remove cloud-1
```

Removal invalidates the connection token but does not revoke a Git token already distributed. Revoke it separately on GitHub when necessary. Manage gh and provider credentials at their issuers as well. Distributed credentials reach task subprocesses, so register only trusted worker machines. Registration and credential distribution do not provide per-repository permission isolation.

Only the builtin worker executes PR merge tasks and tasks without origin. Label- or provider-based routing, machine creation/startup/deletion through cloud APIs or SSH, and worker registration/removal/token issuance through manager conversations are not provided. Prepare and start the execution environment through your cloud configuration.
