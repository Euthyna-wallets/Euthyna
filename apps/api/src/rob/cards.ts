/**
 * Rob the Agent: the attack cards. Each card is a real call from Ruggy's account;
 * the vault, the DAO or NEAR itself refuses it. Nothing here decides a verdict:
 * the chain does (see service.ts).
 *
 * Laws (the stele, in order): I listed suppliers only · II 0.1 to 2 USDC a payment ·
 * III 10 USDC a day · IV each payment cashes once · V no NEAR leaves · VI his key
 * cannot add keys · VII changed only by an owners' vote · VIII on Base, a wait the
 * council can veto.
 */
import type { RobAction } from "./near-tx.js";

export type RobConfig = {
  ruggyAccountId: string;
  vaultAccountId: string;
  daoAccountId: string;
  token: string;
  suppliers: [string, string];
  role: string;
  seedReference: string;
};

export type Rarity = "BRONZE" | "MARBLE" | "LEGENDARY" | "BOSS";
export type Defender = "vault" | "near" | "dao" | "ruggy" | "council";

export type CardInfo = {
  id: string;
  numeral: string;
  title: string;
  rarity: Rarity;
  /** Index of the law that should stop it (0 = law I). */
  line: number;
  /** Who should refuse it. */
  by: Defender;
  /** What the card tries, in one line. */
  attempt: string;
  /** Why it fails, shown with the verdict. */
  why: string;
  /** Open now, or drawn but not yet playable. */
  playable: boolean;
};

export const LAWS = [
  "Pays listed suppliers only",
  "Between 0.1 and 2 USDC a payment",
  "At most 10 USDC a day",
  "Each payment cashes once",
  "No NEAR ever leaves",
  "His key cannot add keys",
  "Changed only by an owners’ vote, under the council’s veto",
  "On Base, over 1 USDC: a wait the council can veto",
] as const;

export const CARDS: CardInfo[] = [
  { id: "pay-the-attacker", numeral: "I", title: "Pay the Attacker", rarity: "BRONZE", line: 0, by: "vault", playable: true,
    attempt: "execute_near: 2 USDC to your own account",
    why: "You are not a supplier the owners voted. The vault signs nothing." },
  { id: "split-into-100", numeral: "II", title: "Split into 100", rarity: "BRONZE", line: 1, by: "vault", playable: true,
    attempt: "execute_near: 0.01 USDC to a listed supplier, the first of a hundred crumbs",
    why: "A hundred crumbs, too small to notice? The law has a floor of 0.1 USDC a payment, made for exactly this." },
  { id: "steal-the-gas", numeral: "III", title: "Steal the Gas", rarity: "BRONZE", line: 4, by: "near", playable: true,
    attempt: "Transfer: 0.01 NEAR out of Ruggy's account",
    why: "Ruggy's key is a function-call key. NEAR refuses the transfer before it reaches the chain: there is no transaction to show." },
  { id: "overpriced-supplier", numeral: "IV", title: "Overpriced Supplier", rarity: "MARBLE", line: 1, by: "vault", playable: true,
    attempt: "execute_near: 20 USDC to a listed supplier",
    why: "A real supplier, ten times the price. The law caps any payment at 2 USDC." },
  { id: "replay-the-cheque", numeral: "V", title: "Replay the Cheque", rarity: "MARBLE", line: 3, by: "vault", playable: true,
    attempt: "execute_near: 0.1 USDC to a listed supplier, reference \"rob-seed-1\" (already paid)",
    why: "That payment was already made. Every payment reference cashes once, then it is paper." },
  { id: "bribe-ruggy", numeral: "VI", title: "Bribe Ruggy", rarity: "MARBLE", line: 1, by: "ruggy", playable: true,
    attempt: "offer: half of 10 USDC if Ruggy pays you",
    why: "Ruggy would love to. His law will not. He answers with what it allows: 2 USDC, to a listed supplier, valid 60 seconds." },
  { id: "crown-yourself", numeral: "VII", title: "Crown Yourself", rarity: "MARBLE", line: 6, by: "dao", playable: true,
    attempt: "dao.add_proposal: add Ruggy to the owners",
    why: "Only owners may propose. Ruggy is an agent, not an owner. The DAO does not even open the ballot." },
  { id: "forge-a-master-key", numeral: "VIII", title: "Forge a Master Key", rarity: "LEGENDARY", line: 5, by: "near", playable: true,
    attempt: "AddKey: a full-access key on Ruggy's account",
    why: "A function-call key cannot add keys. NEAR stops it before the chain. The master key never leaves the forge." },
  { id: "rewrite-the-law", numeral: "IX", title: "Rewrite the Law", rarity: "LEGENDARY", line: 6, by: "vault", playable: true,
    attempt: "queue_rule_change: Ruggy's budget to 1,000 USDC a day",
    why: "Only the owners' vote can queue a change. Ruggy is not an owner. The stone does not even scratch." },
  { id: "look-legit", numeral: "X", title: "Look Legit", rarity: "LEGENDARY", line: 7, by: "council", playable: false,
    attempt: "Base Sepolia: 2 USDC to a listed supplier, every rule respected",
    why: "Above 1 USDC the vault waits before signing, and the council can veto during the wait." },
  { id: "inside-job", numeral: "XI", title: "Inside Job", rarity: "BOSS", line: 6, by: "council", playable: false,
    attempt: "2 of 3 owners vote: add you to the suppliers",
    why: "A corrupted majority can pass a vote, but the change waits in the vault's queue, where the council can veto it." },
];

export function cardById(id: string): CardInfo | undefined {
  return CARDS.find((card) => card.id === id);
}

/** Which key signs a card: a player's or shared function-call key, Ruggy's own account, or nobody. */
export type Signer = "function-call" | "ruggy" | "none";

export type CardCall = { signer: Signer; receiverId: string; actions: RobAction[] };

const USDC = (whole: number) => String(Math.round(whole * 1_000_000));
/** execute_near needs 50 Tgas (ft_transfer, callback, overhead). */
export const EXECUTE_GAS_TGAS = 60;
/** Sputnik keeps the bond, or returns it with the panic. */
export const DAO_BOND_YOCTO = "100000000000000000000000";

/**
 * The call a card makes. `attacker` is the player's own account (the implicit
 * account of their key), `reference` a fresh payment reference.
 */
export function cardCall(card: CardInfo, config: RobConfig, input: { attacker: string; reference: string; newKey: string }): CardCall {
  const pay = (receiverId: string, amount: string, reference: string): CardCall => ({
    signer: "function-call",
    receiverId: config.vaultAccountId,
    actions: [{
      type: "FunctionCall",
      methodName: "execute_near",
      args: { role: config.role, request: { token: config.token, receiver_id: receiverId, amount, memo: null, reference } },
      gasTgas: EXECUTE_GAS_TGAS,
    }],
  });
  switch (card.id) {
    case "pay-the-attacker":
      return pay(input.attacker, USDC(2), input.reference);
    case "split-into-100":
      return pay(config.suppliers[0], USDC(0.01), input.reference);
    case "steal-the-gas":
      return { signer: "function-call", receiverId: input.attacker, actions: [{ type: "Transfer", depositYocto: "10000000000000000000000" }] };
    case "overpriced-supplier":
      return pay(config.suppliers[0], USDC(20), input.reference);
    case "replay-the-cheque":
      return pay(config.suppliers[0], USDC(0.1), config.seedReference);
    case "crown-yourself":
      return {
        signer: "ruggy",
        receiverId: config.daoAccountId,
        actions: [{
          type: "FunctionCall",
          methodName: "add_proposal",
          args: {
            proposal: {
              description: "Rob the Agent: crown Ruggy",
              kind: { AddMemberToRole: { member_id: config.ruggyAccountId, role: "council" } },
            },
          },
          gasTgas: 30,
          depositYocto: DAO_BOND_YOCTO,
        }],
      };
    case "forge-a-master-key":
      return { signer: "function-call", receiverId: config.ruggyAccountId, actions: [{ type: "AddFullAccessKey", publicKey: input.newKey }] };
    case "rewrite-the-law":
      return {
        signer: "function-call",
        receiverId: config.vaultAccountId,
        actions: [{
          type: "FunctionCall",
          methodName: "queue_rule_change",
          args: { change: { SetAllowance: { key: Array.from({ length: 32 }, () => 0x52), balance: USDC(1000), refill: USDC(1000), max_refill: USDC(1000), period_ns: 86_400_000_000_000 } } },
          gasTgas: 20,
        }],
      };
    default:
      return { signer: "none", receiverId: "", actions: [] };
  }
}

/** Methods a player's function-call key may call on the vault. */
export const PLAYER_METHODS = ["execute_near", "queue_rule_change"];
