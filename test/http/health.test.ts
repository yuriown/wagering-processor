import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

test("GET /health/live responde sem autenticacao", async () => {
  const response = await fetch(`${baseUrl}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
