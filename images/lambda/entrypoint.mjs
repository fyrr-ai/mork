// Launch the unchanged AWS runtime client without a shell or npm.
const handler = process.argv[2];
if (!handler || process.argv.length !== 3) throw new Error("Expected one Lambda handler name");
if (!process.env.AWS_LAMBDA_RUNTIME_API) throw new Error("AWS_LAMBDA_RUNTIME_API is required");
const args = [process.execPath, "--expose-gc", "--max-http-header-size=81920"];
const memory = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
if (Number.isFinite(memory) && memory > 0 && !/--max[-_](?:semi|old)[-_]space[-_]size/.test(process.env.NODE_OPTIONS ?? "")) {
  const newSpace = Math.floor(memory / 10);
  args.push(`--max-semi-space-size=${Math.floor(newSpace / 6)}`, `--max-old-space-size=${memory - newSpace}`);
}
args.push("/var/runtime/index.mjs");
process.execve(process.execPath, args, {
  ...process.env,
  _HANDLER: handler,
  AWS_EXECUTION_ENV: "AWS_Lambda_nodejs24.x",
});
