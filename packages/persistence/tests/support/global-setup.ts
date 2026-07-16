import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;

/**
 * Démarre un PostgreSQL réel pour la suite.
 *
 * Pas de mock, pas de SQLite : c'est le comportement de PostgreSQL
 * (RLS, GUC, FK composites) qui est sous test. Un double de test
 * ne prouverait que notre compréhension de PostgreSQL, pas PostgreSQL.
 */
export async function setup() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('lsi_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  // Le propriétaire du schéma : sert aux migrations uniquement.
  process.env.DATABASE_URL = container.getConnectionUri();

  // Le rôle applicatif, créé par la migration. C'est LUI qui est sous test :
  // non-propriétaire, sans BYPASSRLS. (§10.3)
  const uri = new URL(container.getConnectionUri());
  uri.username = 'lsi_app';
  uri.password = 'lsi_app_test_pwd';
  process.env.DATABASE_URL_APP = uri.toString();
}

export async function teardown() {
  await container?.stop();
}
