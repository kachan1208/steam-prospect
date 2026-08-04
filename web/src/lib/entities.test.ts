import { describe, expect, it } from "vitest";

import { splitEntities } from "./entities";

// All example strings below are real mart_game.developers/publishers values.
describe("splitEntities", () => {
  it("returns an empty list for null/undefined/empty", () => {
    expect(splitEntities(null)).toEqual([]);
    expect(splitEntities(undefined)).toEqual([]);
    expect(splitEntities("")).toEqual([]);
  });

  it("passes a single plain name through untouched", () => {
    expect(splitEntities("Mike Klubnika")).toEqual(["Mike Klubnika"]);
  });

  it("splits plain comma-joined credits into separate entities", () => {
    expect(splitEntities("Mike Klubnika,GDeavid")).toEqual(["Mike Klubnika", "GDeavid"]);
    expect(splitEntities("Mike Klubnika,Oro Interactive")).toEqual([
      "Mike Klubnika",
      "Oro Interactive",
    ]);
  });

  it("keeps an in-name corporate suffix attached (', Inc.' is not a second entity)", () => {
    expect(splitEntities("FromSoftware, Inc.")).toEqual(["FromSoftware, Inc."]);
    expect(splitEntities("Blizzard Entertainment, Inc.")).toEqual([
      "Blizzard Entertainment, Inc.",
    ]);
    // No comma before the suffix — nothing to remerge, name unchanged.
    expect(splitEntities("Behaviour Interactive Inc.")).toEqual(["Behaviour Interactive Inc."]);
  });

  it("handles 'Co., Ltd.' style double suffixes", () => {
    expect(splitEntities("CAPCOM Co., Ltd.")).toEqual(["CAPCOM Co., Ltd."]);
  });

  it("splits real credits while re-merging each entity's own suffix", () => {
    expect(splitEntities("FromSoftware, Inc.,Bandai Namco Entertainment")).toEqual([
      "FromSoftware, Inc.",
      "Bandai Namco Entertainment",
    ]);
    expect(splitEntities("Nicalis, Inc.,Edmund McMillen")).toEqual([
      "Nicalis, Inc.",
      "Edmund McMillen",
    ]);
  });

  it("re-merges a suffix carrying a parenthetical region note, and keeps unicode names", () => {
    // Sekiro's publishers string.
    expect(
      splitEntities("Activision (Excluding Japan and Asia),FromSoftware, Inc. (Japan),方块游戏 (Asia)"),
    ).toEqual(["Activision (Excluding Japan and Asia)", "FromSoftware, Inc. (Japan)", "方块游戏 (Asia)"]);
  });

  it("does not treat suffix-prefixed names (Co-op, Ltd Edition …) as remergeable suffixes", () => {
    expect(splitEntities("Team Alpha,Co-op Games")).toEqual(["Team Alpha", "Co-op Games"]);
  });
});
