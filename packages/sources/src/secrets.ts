// Secrets come from the environment locally and from Secrets Manager in AWS
// (`<NAME>_SECRET_ID`), so no secret value ever sits in Terraform state or git.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export async function loadSecrets(env: NodeJS.ProcessEnv, names: string[]): Promise<void> {
  const pending = names.filter((name) => !env[name] && env[`${name}_SECRET_ID`]);
  if (!pending.length) return;
  const client = new SecretsManagerClient({});
  for (const name of pending) {
    const secret = await client.send(new GetSecretValueCommand({ SecretId: env[`${name}_SECRET_ID`] }));
    if (!secret.SecretString) throw new Error(`secret for ${name} is empty`);
    env[name] = secret.SecretString;
  }
}
