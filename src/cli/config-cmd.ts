import { Command } from 'commander';
import { loadConfig, saveConfig, type ClimConfig } from '../shared/config.js';
import { EXIT_CODES } from '../shared/constants.js';
import { printData, printError, printJson, printSuccess } from '../shared/output.js';

const VALID_KEYS = ['provisioningUrl', 'defaultAgent', 'timeout', 'outputFormat'] as const;

type ConfigKey = (typeof VALID_KEYS)[number];

function isValidKey(key: string): key is ConfigKey {
  return VALID_KEYS.includes(key as ConfigKey);
}

function fail(code: number): never {
  process.exit(code);
}

function formatConfigOutput(config: ClimConfig): string {
  const lines: string[] = [];
  lines.push(`provisioningUrl: ${config.provisioningUrl}`);
  if (config.defaultAgent !== undefined) {
    lines.push(`defaultAgent: ${config.defaultAgent}`);
  }
  if (config.timeout !== undefined) {
    lines.push(`timeout: ${config.timeout}`);
  }
  if (config.outputFormat !== undefined) {
    lines.push(`outputFormat: ${config.outputFormat}`);
  }
  return lines.join('\n');
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage CLI configuration');

  // clim config (show all)
  config.action(async () => {
    try {
      const cfg = await loadConfig();
      printData(formatConfigOutput(cfg));
    } catch (error) {
      printError(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
      fail(EXIT_CODES.ERROR);
    }
  });

  // clim config get <key>
  config
    .command('get')
    .argument('<key>', 'Config key')
    .action(async (key: string) => {
      if (!isValidKey(key)) {
        printError(`Invalid config key: ${key}`);
        printError(`Valid keys: ${VALID_KEYS.join(', ')}`);
        fail(EXIT_CODES.INVALID_ARGS);
      }

      try {
        const cfg = await loadConfig();
        const value = cfg[key];
        if (value === undefined) {
          printData('');
        } else {
          printData(String(value));
        }
      } catch (error) {
        printError(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });

  // clim config set <key> <value>
  config
    .command('set')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .option('--json', 'JSON output')
    .action(async (key: string, value: string, opts: { json?: boolean }) => {
      if (!isValidKey(key)) {
        printError(`Invalid config key: ${key}`);
        printError(`Valid keys: ${VALID_KEYS.join(', ')}`);
        fail(EXIT_CODES.INVALID_ARGS);
      }

      try {
        // Validate and parse value based on key
        let parsedValue: unknown;

        if (key === 'timeout') {
          const num = Number.parseInt(value, 10);
          if (!Number.isFinite(num) || num <= 0) {
            printError('timeout must be a positive number');
            fail(EXIT_CODES.INVALID_ARGS);
          }
          parsedValue = num;
        } else if (key === 'outputFormat') {
          if (value !== 'text' && value !== 'json') {
            printError("outputFormat must be 'text' or 'json'");
            fail(EXIT_CODES.INVALID_ARGS);
          }
          parsedValue = value;
        } else {
          parsedValue = value;
        }

        const update: Partial<ClimConfig> = {
          [key]: parsedValue,
        };

        await saveConfig(update);

        if (opts.json) {
          printJson({ key, value: parsedValue });
        } else {
          printSuccess(`Config updated: ${key} = ${parsedValue}`);
        }
      } catch (error) {
        printError(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });

  // clim config reset
  config
    .command('reset')
    .description('Reset configuration to defaults')
    .action(async () => {
      try {
        await saveConfig({
          provisioningUrl: 'https://pocket-claw-dev.vibelandapp.com',
        });
        printSuccess('Configuration reset to defaults');
      } catch (error) {
        printError(`Failed to reset config: ${error instanceof Error ? error.message : String(error)}`);
        fail(EXIT_CODES.ERROR);
      }
    });
}
