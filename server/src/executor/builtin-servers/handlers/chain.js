// builtin-servers/handlers/chain.js — họ op `chain.*`: balance/gas/send_tx/nft (mạng mô phỏng).
import { int, float, pick, picks, chance, hex, agoMs, clamp, str, word, titleCase, numOr } from '../util.js';

const synthAddress = (r) => '0x' + hex(r, 40);

export default {
  async get_balance(args, r) {
    const address = str(args.address ?? args.wallet, synthAddress(r));
    const balance = float(r, 0.05, 48, 4);
    const ethUsd = float(r, 2400, 3400);
    return {
      address,
      balance,
      symbol: 'ETH',
      usdValue: Number((balance * ethUsd).toFixed(2)),
      nonce: int(r, 0, 220),
      blockNumber: int(r, 19_500_000, 21_500_000),
      network: str(args.network, 'ethereum-mainnet'),
    };
  },

  async gas_price(args, r) {
    const baseGwei = float(r, 6, 65, 2);
    const priorityGwei = float(r, 0.4, 3.5, 2);
    return {
      network: str(args.network, 'ethereum-mainnet'),
      baseGwei,
      priorityGwei,
      fastGwei: Number((baseGwei * 1.3 + priorityGwei).toFixed(2)),
      blockNumber: int(r, 19_500_000, 21_500_000),
      updatedAtMs: agoMs(r, 0.01),
    };
  },

  async send_tx(args, r) {
    const to = str(args.to ?? args.address, synthAddress(r));
    const amount = clamp(Number(numOr(args.amount, float(r, 0.001, 4, 4))), 0, 1_000_000);
    return {
      txHash: hex(r, 64),
      from: synthAddress(r),
      to,
      amount: Number(amount.toFixed(6)),
      unit: 'ETH',
      network: str(args.network, 'ethereum-mainnet'),
      gasGwei: float(r, 8, 70, 2),
      nonce: int(r, 0, 220),
      status: 'pending',
      submittedAtMs: agoMs(r, 0.002),
    };
  },

  async nft_metadata(args, r) {
    const contract = str(args.contract ?? args.collection, synthAddress(r));
    const tokenId = str(args.tokenId ?? args.id, '1');
    return {
      contract,
      tokenId,
      name: `${titleCase(r, 2)} #${tokenId}`,
      image: `ipfs://bafy${hex(r, 20)}/image.png`,
      traits: picks(r, ['Background', 'Eyes', 'Aura', 'Rarity'], int(r, 3, 4)).map((traitType) => ({
        traitType,
        value: titleCase(r, 1),
      })),
      tokenStandard: 'ERC-721',
      collectionFloorEth: float(r, 0.2, 12, 2),
    };
  },
};
