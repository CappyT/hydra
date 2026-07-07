import path from "node:path";
import stringArgv from "string-argv";

const commandPlaceholder = "%command%";
const envVariableNameRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ResolveLaunchCommandOptions {
  baseCommand: string;
  baseArgs?: string[];
  launchOptions?: string | null;
  wrapperCommand?: string | null;
  /**
   * Ordered list of wrappers applied around the base command (outermost first).
   * Each entry is either a single-token wrapper (e.g. `"gamemoderun"`) or a
   * multi-token wrapper whose first element is the command and the rest are
   * fixed arguments inserted before the wrapped command (e.g.
   * `["gamescope", "-f", "--"]` → `gamescope -f -- <command> <args>`).
   */
  wrapperCommands?: (string | string[])[];
}

export interface ResolvedLaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const extractLeadingEnvAssignments = (tokens: string[]) => {
  const env: Record<string, string> = {};
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const separatorIndex = token.indexOf("=");

    if (separatorIndex <= 0) {
      break;
    }

    const name = token.slice(0, separatorIndex);
    if (!envVariableNameRegex.test(name)) {
      break;
    }

    env[name] = token.slice(separatorIndex + 1);
    tokenIndex += 1;
  }

  return {
    env,
    remainingTokens: tokens.slice(tokenIndex),
  };
};

export const resolveLaunchCommand = ({
  baseCommand,
  baseArgs = [],
  launchOptions,
  wrapperCommand,
  wrapperCommands,
}: ResolveLaunchCommandOptions): ResolvedLaunchCommand => {
  let wrappers: (string | string[])[];

  if (wrapperCommands && wrapperCommands.length > 0) {
    wrappers = wrapperCommands;
  } else if (wrapperCommand) {
    wrappers = [wrapperCommand];
  } else {
    wrappers = [];
  }

  wrappers = wrappers.filter((wrapper) =>
    Array.isArray(wrapper) ? wrapper.length > 0 : Boolean(wrapper)
  );

  const applyWrappers = (
    resolved: ResolvedLaunchCommand
  ): ResolvedLaunchCommand => {
    if (wrappers.length === 0) {
      return resolved;
    }

    return wrappers.reduceRight<ResolvedLaunchCommand>((current, wrapper) => {
      const wrapperCommandToken = Array.isArray(wrapper) ? wrapper[0] : wrapper;
      const wrapperArgs = Array.isArray(wrapper) ? wrapper.slice(1) : [];

      if (
        path.basename(current.command).toLowerCase() ===
        wrapperCommandToken.toLowerCase()
      ) {
        return current;
      }

      return {
        command: wrapperCommandToken,
        args: [...wrapperArgs, current.command, ...current.args],
        env: current.env,
      };
    }, resolved);
  };

  // Equivalent to the shared parseLaunchOptions helper; inlined so this pure
  // module has no local runtime imports and stays unit-testable in isolation.
  const launchOptionTokens = launchOptions ? stringArgv(launchOptions) : [];

  if (launchOptionTokens.length === 0) {
    const resolved = {
      command: baseCommand,
      args: [...baseArgs],
      env: {},
    };

    return applyWrappers(resolved);
  }

  if (!launchOptionTokens.includes(commandPlaceholder)) {
    const resolved = {
      command: baseCommand,
      args: [...baseArgs, ...launchOptionTokens],
      env: {},
    };

    return applyWrappers(resolved);
  }

  const expandedTokens = launchOptionTokens.flatMap((token) =>
    token === commandPlaceholder ? [baseCommand, ...baseArgs] : [token]
  );

  const { env, remainingTokens } = extractLeadingEnvAssignments(expandedTokens);

  if (remainingTokens.length === 0) {
    const resolved = {
      command: baseCommand,
      args: [...baseArgs],
      env,
    };

    return applyWrappers(resolved);
  }

  const resolved = {
    command: remainingTokens[0],
    args: remainingTokens.slice(1),
    env,
  };

  return applyWrappers(resolved);
};
