import "dotenv/config";

const testUrl = process.env.REGEAR_TEST_DATABASE_URL;
if (!testUrl) {
  console.error("Set REGEAR_TEST_DATABASE_URL to an isolated PostgreSQL database before running integration tests.");
  process.exit(1);
}

let databaseName;
let testDatabase;
try {
  testDatabase = new URL(testUrl);
  if (!/^postgres(?:ql)?:$/.test(testDatabase.protocol)) throw new Error("unsupported protocol");
  databaseName = decodeURIComponent(testDatabase.pathname.slice(1));
} catch {
  console.error("REGEAR_TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  process.exit(1);
}

if (!databaseName.endsWith("_test")) {
  console.error("Integration tests only run against a database whose name ends with _test.");
  process.exit(1);
}

let applicationDatabase;
try {
  applicationDatabase = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
} catch {
  console.error("DATABASE_URL must be a valid database URL.");
  process.exit(1);
}

const databaseIdentity = databaseUrl => {
  const defaultPort = databaseUrl.protocol === "postgres:" || databaseUrl.protocol === "postgresql:" ? "5432" : "";
  return `${databaseUrl.hostname.toLowerCase()}:${databaseUrl.port || defaultPort}/${decodeURIComponent(databaseUrl.pathname.slice(1))}`;
};

if (applicationDatabase && databaseIdentity(applicationDatabase) === databaseIdentity(testDatabase)) {
  console.error("The test database must be isolated from DATABASE_URL.");
  process.exit(1);
}
