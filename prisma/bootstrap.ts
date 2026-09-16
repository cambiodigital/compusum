type CommandFailure = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const bunExecutable = process.execPath;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL no esta definido. No es posible ejecutar migrate, validar alineacion ni correr seed.");
  process.exit(1);
}

const run = async (command: string[], errorMessage?: string) => {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  if (exitCode !== 0) {
    const failure = new Error(errorMessage ?? `Command failed: ${command.join(" ")}`) as Error & {
      details?: CommandFailure;
    };

    failure.details = { exitCode, stdout, stderr };
    throw failure;
  }

  return { stdout, stderr };
};

// POLITICA FAIL-CLOSED (Fase 7):
// startup = migrate deploy -> validacion -> seed -> app.
// Si `migrate deploy` falla, el contenedor DEBE fallar. Nunca se marca una
// migracion failed como rolled-back (P3009) ni se baselinea arbitrariamente
// (P3005): eso alteraria `_prisma_migrations` para "lograr arrancar" y puede
// dejar el esquema a medias. La resolucion manual con `prisma migrate resolve`
// esta documentada en docs/ops/migraciones-recuperacion.md y se ejecuta SOLO
// como procedimiento de incidente, con humano al mando.
try {
  await run([bunExecutable, "x", "prisma", "generate"], "Prisma generate failed.");
  await run([bunExecutable, "x", "prisma", "migrate", "deploy"], "Prisma migrate deploy failed.");
  await run([bunExecutable, "prisma/validate-operational-alignment.ts"], "Operational schema validation failed.");
  await run([bunExecutable, "run", "seed"], "Seed failed.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof Error && "details" in error && error.details
      ? error.details
      : undefined;

  console.error("-----------------------------------------------------------");
  console.error("Fallo el arranque de la base de datos (politica fail-closed).");
  console.error("Paso fallido:", message);

  if (details) {
    if (details.stdout.trim()) console.error(details.stdout.trim());
    if (details.stderr.trim()) console.error(details.stderr.trim());
  }

  if (message.includes("P3009") || (details?.stderr ?? "").includes("P3009") || (details?.stdout ?? "").includes("P3009")) {
    console.error(
      "Hay una migracion en estado failed (_prisma_migrations). NO se resuelve automaticamente.\n" +
        "Siga el runbook docs/ops/migraciones-recuperacion.md: corregir la causa y resolver MANUALMENTE con\n" +
        "`prisma migrate resolve --rolled-back <migration>` (o --applied) antes de reintentar el deploy."
    );
  } else if (message.includes("P3005")) {
    console.error(
      "La base de datos parece no baselineada (P3005). NO se baselinea automaticamente.\n" +
        "Siga el runbook docs/ops/migraciones-recuperacion.md para evaluar y, si corresponde, aplicar\n" +
        "MANUALMENTE `prisma migrate resolve --applied 0_init`."
    );
  }

  console.error("El contenedor no arrancara hasta que la migracion se recupere manualmente.");
  console.error("-----------------------------------------------------------");
  process.exit(1);
}
