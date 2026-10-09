import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

/**
 * Identidade do provedor que fez a chamada.
 * `providerId` undefined = canal nao autenticado (modo atual, ver ARCHITECTURE.md).
 */
export interface ProviderIdentity {
  providerId: string | undefined;
}

/**
 * Ponto de extensao da autenticacao. A implementacao real validaria um access token
 * OIDC (client_credentials emitido por um IdP como Keycloak) e devolveria o provedor
 * da claim; aqui so existe a versao que confia no canal.
 */
export interface ProviderIdentityPort {
  resolve(request: Request): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

/** Sem IdP: toda chamada e aceita e nenhum provedor e afirmado. */
export class UnauthenticatedProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return { providerId: undefined };
  }
}

export const IS_PUBLIC = "isPublic";
/** Rota sem autenticacao (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthenticatedRequest extends Request {
  providerIdentity?: ProviderIdentity;
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.providerIdentity = await this.identity.resolve(request);
    return true;
  }
}

/** Com IdP ligado, o provedor autenticado so pode operar em nome de si mesmo. */
export function assertActsAsProvider(request: AuthenticatedRequest, providerId: string): void {
  const authenticated = request.providerIdentity?.providerId;
  if (authenticated !== undefined && authenticated !== providerId) {
    throw new ForbiddenException({
      error: { code: "PROVIDER_MISMATCH", message: `credencial de ${authenticated} nao opera por ${providerId}` },
    });
  }
}
