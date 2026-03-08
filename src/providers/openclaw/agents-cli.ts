import { Command } from 'commander';
import {
  ProvisioningClient,
  ProvisioningError,
  isNetworkError,
} from '../../client/provisioning.js';
import { loadConfig } from '../../shared/config.js';
import { EXIT_CODES } from '../../shared/constants.js';
import { printData, printError, printJson, printSuccess, printInfo } from '../../shared/output.js';
import { ProfileManager } from '../../shared/profile.js';

function fail(code: number): never {
  process.exit(code);
}

function handleError(error: unknown, provisioningUrl: string): never {
  if (isNetworkError(error)) {
    printError(`Cannot reach Provisioning at ${provisioningUrl}. Check network.`);
    fail(EXIT_CODES.NETWORK_ERROR);
  }

  if (error instanceof ProvisioningError) {
    if (error.statusCode === 401) {
      printError('Unauthorized. Check your credentials.');
      fail(EXIT_CODES.AUTH_FAILED);
    }

    if (error.statusCode === 404) {
      printError('Agent not found.');
      fail(EXIT_CODES.NOT_FOUND);
    }

    if (error.statusCode === 400) {
      printError(`Request rejected: ${error.message}`);
      fail(EXIT_CODES.INVALID_ARGS);
    }

    printError(error.message);
    fail(EXIT_CODES.ERROR);
  }

  printError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  fail(EXIT_CODES.ERROR);
}

interface AgentOptions {
  json?: boolean;
}

interface CreateAgentOptions extends AgentOptions {
  name: string;
  model?: string;
}

interface UpdateAgentOptions extends AgentOptions {
  name?: string;
  model?: string;
}

interface DeleteAgentOptions extends AgentOptions {
  force?: boolean;
}

export function registerAgentsCommand(program: Command): void {
  const agentsCmd = program
    .command('agents')
    .description('Manage agents');

  // Default: list agents
  agentsCmd
    .option('--json', 'JSON output')
    .action(async (opts: AgentOptions) => {
      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();
        const result = await client.listAgents(credentials.accessToken);

        if (opts.json) {
          printJson(result);
          return;
        }

        if (result.agents.length === 0) {
          printInfo('No agents found.');
          return;
        }

        printData('Agents:');
        for (const agent of result.agents) {
          const name = (agent as Record<string,unknown>).displayName ?? (agent as Record<string,unknown>).name ?? '';
          const model = (agent as Record<string,unknown>).modelId ?? (agent as Record<string,unknown>).model ?? '';
          const modelStr = model ? `  ${model}` : '';
          printData(`  ${String(agent.id).padEnd(12)} ${String(name).padEnd(20)}${modelStr}`);
        }
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

  // Subcommand: list
  agentsCmd
    .command('list')
    .description('List all agents')
    .option('--json', 'JSON output')
    .action(async (opts: AgentOptions) => {
      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();
        const result = await client.listAgents(credentials.accessToken);

        if (opts.json) {
          printJson(result);
          return;
        }

        if (result.agents.length === 0) {
          printInfo('No agents found.');
          return;
        }

        printData('Agents:');
        for (const agent of result.agents) {
          const name = (agent as Record<string,unknown>).displayName ?? (agent as Record<string,unknown>).name ?? '';
          const model = (agent as Record<string,unknown>).modelId ?? (agent as Record<string,unknown>).model ?? '';
          const modelStr = model ? `  ${model}` : '';
          printData(`  ${String(agent.id).padEnd(12)} ${String(name).padEnd(20)}${modelStr}`);
        }
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

  // Subcommand: create
  agentsCmd
    .command('create')
    .description('Create a new agent')
    .requiredOption('--name <name>', 'Agent name')
    .option('--model <model>', 'Model ID')
    .option('--json', 'JSON output')
    .action(async (opts: CreateAgentOptions) => {
      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();
        const agent = await client.createAgent(credentials.accessToken, {
          name: opts.name,
          model: opts.model,
        });

        if (opts.json) {
          printJson(agent);
          return;
        }

        printSuccess(`Created agent: ${agent.id}`);
        printData(`  Name: ${agent.name}`);
        if (agent.model) {
          printData(`  Model: ${agent.model}`);
        }
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

  // Subcommand: update
  agentsCmd
    .command('update <id>')
    .description('Update an agent')
    .option('--name <name>', 'New agent name')
    .option('--model <model>', 'New model ID')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: UpdateAgentOptions) => {
      if (!opts.name && !opts.model) {
        printError('Specify at least one of: --name, --model');
        fail(EXIT_CODES.INVALID_ARGS);
      }

      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();
        const agent = await client.updateAgent(credentials.accessToken, id, {
          name: opts.name,
          model: opts.model,
        });

        if (opts.json) {
          printJson(agent);
          return;
        }

        printSuccess(`Updated agent: ${agent.id}`);
        printData(`  Name: ${agent.name}`);
        if (agent.model) {
          printData(`  Model: ${agent.model}`);
        }
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

  // Subcommand: delete
  agentsCmd
    .command('delete <id>')
    .description('Delete an agent')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: DeleteAgentOptions) => {
      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();
        await client.deleteAgent(credentials.accessToken, id);

        if (opts.json) {
          printJson({ ok: true, id });
          return;
        }

        printSuccess(`Deleted agent: ${id}`);
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

  // Subcommand: models
  agentsCmd
    .command('models')
    .description('List available models')
    .option('--json', 'JSON output')
    .action(async (opts: AgentOptions) => {
      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();
        const result = await client.listModels(credentials.accessToken);

        if (opts.json) {
          printJson(result);
          return;
        }

        if (result.models.length === 0) {
          printInfo('No models available.');
          return;
        }

        printData('Available models:');
        for (const model of result.models) {
          printData(`  ${model.id.padEnd(40)} (${model.ownedBy})`);
        }
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

  // Subcommand: provision
  // Triggers on-demand Gateway + PieBox creation for social-only users
  agentsCmd
    .command('provision')
    .description('Provision an AI agent (creates Gateway container on-demand)')
    .option('--json', 'JSON output')
    .action(async (opts: AgentOptions) => {
      const profileManager = new ProfileManager();
      const config = await loadConfig();
      const client = new ProvisioningClient(config.provisioningUrl);

      try {
        const credentials = await profileManager.loadCredentials();

        // Check if already provisioned
        if (credentials.gatewayUrl) {
          if (opts.json) {
            printJson({ alreadyProvisioned: true, gatewayUrl: credentials.gatewayUrl });
            return;
          }
          printInfo('AI agent already provisioned.');
          printData(`  Gateway: ${credentials.gatewayUrl}`);
          return;
        }

        printInfo('Provisioning AI agent (this may take a minute)...');

        const result = await client.provisionAgent(credentials.accessToken);

        // Update stored credentials with gateway info
        credentials.gatewayUrl = result.gatewayUrl;
        credentials.gatewayToken = result.gatewayToken;
        credentials.nodeDeviceKeyPem = result.nodeDeviceKeyPem;
        credentials.cliNodeDeviceKeyPem = result.cliNodeDeviceKeyPem;
        await profileManager.saveCredentials(credentials.email, credentials);

        if (opts.json) {
          printJson(result);
          return;
        }

        printSuccess('AI agent provisioned!');
        printData(`  Gateway: ${result.gatewayUrl}`);
        printInfo('Restart daemon to connect: clim daemon restart');
      } catch (error) {
        handleError(error, config.provisioningUrl);
      }
    });

}
