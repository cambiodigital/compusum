const databaseUrl = process.env.DATABASE_URL;
const bunExecutable = process.execPath;

if (!databaseUrl) {
  console.error("DATABASE_URL no esta definido.");
  process.exit(1);
}

(async () => {
  const processResult = Bun.spawn(
    [
      bunExecutable,
      "x",
      "prisma",
      "migrate",
      "diff",
      "--from-url",
      databaseUrl,
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--script",
      "--exit-code",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);

  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  if (exitCode === 0) {
    console.log("Operational schema validation passed.");
    process.exit(0);
  }

  if (exitCode === 2) {
    // Known DB-native indexes that Prisma schema cannot natively represent (e.g. partial unique indexes, tsvector GIN indexes).
    const allowedDbNativeDropIndexPatterns = [
      /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Product_searchVector_idx";?/i,
      /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"CartItem_cartId_productId_base_unique";?/i,
      /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"CartItem_cartId_productId_variant_unique";?/i,
      /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Order_sessionId_status_unique_idx";?/i,
      /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Order_customerId_status_unique_idx";?/i,
      /^DROP\s+INDEX\s+(IF\s+EXISTS\s+)?("public"\.)?"Cart_sessionId_status_unique_idx";?/i,
    ];

    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"));

    const unhandledLines = lines.filter((line) => {
      return !allowedDbNativeDropIndexPatterns.some((pattern) => pattern.test(line));
    });

    if (unhandledLines.length > 0) {
      console.error(
        "La base de datos no coincide con prisma/schema.prisma despues de migrate deploy (se detecto drift operativo de indices o estructura no autorizada). Aborto antes del seed.",
      );
      console.error("Lineas no autorizadas en diff:", unhandledLines.join("\n"));
      process.exit(1);
    }

    console.log("Operational schema validation passed (ignoring expected DB-native partial/GIN indexes).");
    process.exit(0);
  }

  process.exit(exitCode);
})();