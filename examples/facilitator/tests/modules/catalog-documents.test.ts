import { describe, it, expect } from "vitest";

import {
  buildEmbedDocument,
  buildSearchDocument,
  type CatalogRecord,
} from "../../src/modules/catalog/store.js";

const record: CatalogRecord = {
  resource: "https://api.example.com/weather/forecast",
  type: "http",
  method: "GET",
  x402Version: 2,
  accepts: [],
  serviceName: "Stellar Weather",
  description: "Hourly forecast for any city",
  tags: ["weather", "forecast"],
  extensions: {
    bazaar: {
      info: {
        input: { type: "http", method: "GET", queryParams: { city: "San Francisco" } },
        output: { type: "json", example: { tempC: 17, humidity: 68, windKph: 12 } },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: { city: { type: "string", description: "The city to forecast" } },
          },
        },
      },
    },
  },
};

describe("search document", () => {
  it("carries the words a query would use", () => {
    const document = buildSearchDocument(record);

    expect(document).toContain("Stellar Weather");
    expect(document).toContain("Hourly forecast for any city");
    expect(document).toContain("weather forecast");
  });

  it("turns the url path into words", () => {
    // `/weather/forecast` should be searchable as two words, not one token.
    expect(buildSearchDocument(record)).toContain("weather forecast");
  });

  it("includes the output example's keys so response shape is searchable", () => {
    const document = buildSearchDocument(record);

    expect(document).toContain("tempC");
    expect(document).toContain("windKph");
  });

  it("survives a resource that is not a parsable url", () => {
    const document = buildSearchDocument({ ...record, resource: "not a url" });
    expect(document).toContain("Stellar Weather");
  });
});

describe("embed document", () => {
  it("names the input parameters", () => {
    expect(buildEmbedDocument(record)).toContain("city");
  });

  it("leaves out the JSON Schema, which would eat the token budget", () => {
    const document = buildEmbedDocument(record);

    expect(document).not.toContain("json-schema.org");
    expect(document).not.toContain("additionalProperties");
    expect(document).not.toContain("The city to forecast");
  });

  it("leaves out the output example values", () => {
    // MiniLM truncates at 256 word-pieces; response boilerplate would push the
    // description out and pull every embedding closer together.
    const document = buildEmbedDocument(record);

    expect(document).not.toContain("humidity");
    expect(document).not.toContain("17");
  });

  it("stays shorter than the lexical document", () => {
    expect(buildEmbedDocument(record).length).toBeLessThan(buildSearchDocument(record).length);
  });
});
