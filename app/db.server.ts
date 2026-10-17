import { PrismaClient } from "@prisma/client";
import { withPoolSettings } from "./lib/db-url-shared";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/** One client per process, with an explicit connection pool (lib/db-url-shared, DB scale #5). */
function createClient(): PrismaClient {
  const url = withPoolSettings(process.env.DATABASE_URL);
  return url ? new PrismaClient({ datasourceUrl: url }) : new PrismaClient();
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
