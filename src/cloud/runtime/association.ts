import type {
  ConversationAssociationCandidate,
  ConversationAssociationVerifier,
  VerifiedConversationAssociation,
} from "../control-plane/index.js";

export interface ConfiguredOwnerAssociation {
  ownerId: string;
  conversationId: string;
  phoneE164: string;
  sendblueNumber?: string;
  providerConversationId?: string;
}

export interface ConfiguredAssociationVerifierOptions {
  associations: readonly ConfiguredOwnerAssociation[];
  sendblueNumber: string;
}

/** Exact allowlist matching; zero or ambiguous matches are both unverified. */
export class ConfiguredAssociationVerifier implements ConversationAssociationVerifier {
  readonly #associations: readonly ConfiguredOwnerAssociation[];
  readonly #sendblueNumber: string;

  constructor(options: ConfiguredAssociationVerifierOptions) {
    this.#associations = structuredClone(options.associations);
    this.#sendblueNumber = options.sendblueNumber;
  }

  async verify(
    candidate: ConversationAssociationCandidate,
  ): Promise<VerifiedConversationAssociation | null> {
    if (candidate.provider !== "sendblue" || candidate.toPhone !== this.#sendblueNumber) {
      return null;
    }
    const matches = this.#associations.filter((association) =>
      association.phoneE164 === candidate.fromPhone &&
      (association.sendblueNumber ?? this.#sendblueNumber) === candidate.toPhone &&
      association.providerConversationId === candidate.providerConversationId);
    const unique = new Map(matches.map((association) => [
      `${association.ownerId}\0${association.conversationId}\0${association.phoneE164}`,
      association,
    ]));
    if (unique.size !== 1) return null;
    const association = [...unique.values()][0]!;
    return {
      ownerId: association.ownerId,
      conversationId: association.conversationId,
      phoneE164: association.phoneE164,
    };
  }
}
