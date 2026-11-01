import { DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand, ParameterNotFound, PutParameterCommand } from "@aws-sdk/client-ssm";
import type { SsmClient } from "./core/vault.ts";

// In-memory Parameter Store for tests: the four commands Sikrets sends, with a version history per
// parameter like the real one keeps, and no network.
export function fakeSsm() {
  const params = new Map<string, string>();
  const history = new Map<string, string[]>();
  const calls: string[] = [];
  const notFound = () => new ParameterNotFound({ message: "not found", $metadata: {} });
  const client: SsmClient = {
    async send(command: object) {
      if (command instanceof PutParameterCommand) {
        const { Name, Value } = command.input;
        calls.push(`put ${Name}`);
        params.set(Name!, Value!);
        history.set(Name!, [...(history.get(Name!) ?? []), Value!]);
        return {};
      }
      if (command instanceof GetParameterCommand) {
        const value = params.get(command.input.Name!);
        if (value === undefined) throw notFound();
        return { Parameter: { Name: command.input.Name, Value: value } };
      }
      if (command instanceof GetParametersByPathCommand) {
        const prefix = `${command.input.Path}/`;
        const all = [...params].filter(([n]) => n.startsWith(prefix) && !n.slice(prefix.length).includes("/"));
        // Two per page, so pagination is exercised.
        const start = Number(command.input.NextToken ?? 0);
        const page = all.slice(start, start + 2).map(([Name, Value]) => ({ Name, Value }));
        return { Parameters: page, NextToken: start + 2 < all.length ? String(start + 2) : undefined };
      }
      if (command instanceof DeleteParameterCommand) {
        calls.push(`delete ${command.input.Name}`);
        if (!params.delete(command.input.Name!)) throw notFound();
        history.delete(command.input.Name!);
        return {};
      }
      throw new Error(`fake SSM doesn't handle ${command.constructor.name}`);
    },
  };
  return { client, params, history, calls };
}
