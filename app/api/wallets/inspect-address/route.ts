import { NextRequest, NextResponse } from "next/server";
import { checkWalletAddress, tokenContractLabel } from "@/lib/wallet-address";

// Inspection d'une adresse AVANT enregistrement — formulaire admin uniquement.
//
// ⚠️ Ce n'est PAS une garde : la garde dure vit dans lib/wallet-address.ts et
// s'applique de toute façon à l'écriture. Ici on ajoute une seule information
// que la garde ne peut pas donner sans appel réseau : « TronGrid dit que cette
// adresse est un compte de type Contract ».
//
// Pourquoi un avertissement et pas un refus : audit du 16/08/2026 — 74 des 275
// adresses en base sont des comptes de type Contract, dont trois wallets de
// trésorerie de l'opérateur et 48 wallets de dépôt joueurs avec des dépôts
// réels. Sur TRON, une adresse de dépôt d'app de poker est très souvent un
// contrat collecteur. Refuser serait faux dans la majorité des cas ; signaler
// laisse l'humain trancher.

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const address = typeof body.address === "string" ? body.address.trim() : "";

  const check = checkWalletAddress(address);
  if (!check.ok) {
    // Rejet local, sans réseau : format/checksum invalide ou contrat de token connu.
    return NextResponse.json({
      address,
      accepted: false,
      code: check.code,
      message: check.message,
      token_contract: tokenContractLabel(address),
    });
  }

  // L'adresse passera la garde. Reste l'information réseau, purement indicative.
  let isContract: boolean | null = null;
  let contractNote: string | null = null;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = process.env.TRONGRID_API_KEY;
    if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

    const res = await fetch(`https://api.trongrid.io/v1/accounts/${check.address}`, {
      headers,
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 0 },
    });
    if (res.ok) {
      const json = await res.json();
      const acc = json?.data?.[0];
      isContract = acc?.type === "Contract";
      if (isContract) {
        contractNote =
          "TronGrid indique un compte de type « Contract ». C'est courant et légitime pour " +
          "une adresse de dépôt fournie par une app de poker ou un exchange — mais c'est aussi " +
          "ce qu'est un contrat de token. Vérifie que l'adresse vient bien de l'écran « Deposit » " +
          "de l'app avant d'enregistrer.";
      }
    }
  } catch {
    // TronGrid indisponible ou lent : l'inspection est un confort, jamais un bloquant.
    isContract = null;
  }

  return NextResponse.json({
    address: check.address,
    accepted: true,
    is_contract: isContract, // null = non déterminé (réseau indisponible)
    warning: contractNote,
  });
}
