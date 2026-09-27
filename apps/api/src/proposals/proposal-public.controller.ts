import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/public.decorator.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { sendFile } from '../common/http-io.js';
import { ProposalPublicService } from './proposal-public.service.js';
import { PublicRateLimiter } from './public-rate-limit.js';
import { hashToken } from './proposal-links.js';
import {
  AcceptSchema,
  DeclineSchema,
  OtpVerifySchema,
  PublicCommentSchema,
  SelectionSchema,
  ViewEventsSchema,
  type AcceptBody,
  type SelectionBody,
  type ViewEventsBody,
} from './proposals.schemas.js';

/**
 * Page publique d'une proposition — API de `/p/<jeton>` (brief §12.5).
 *
 * @Public() : pas de session. La compensation est « un autre contrôle » :
 * jeton aléatoire de 256 bits haché en base, résolu par une fonction bornée,
 * lecture confinée à la proposition (RLS), limitation de débit, `noindex`,
 * aucune mise en cache. Code à usage unique (en-tête `x-proposal-otp`) pour
 * les propositions sensibles et l'acceptation par clic.
 */
@Controller('v1/public/proposals')
export class ProposalPublicController {
  constructor(
    private readonly service: ProposalPublicService,
    private readonly limiter: PublicRateLimiter,
  ) {}

  /**
   * En-têtes de la page publique + limitation de débit à DEUX niveaux : par
   * lien (le jeton, haché : jamais en clair dans Redis) selon l'action, et par
   * adresse IP, plus large (un bureau entier derrière une même IP).
   */
  private async guard(req: FastifyRequest, res: FastifyReply, bucket: string, limit: number) {
    void res.header('X-Robots-Tag', 'noindex, nofollow, noarchive').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const token = (req.params as { token?: string }).token ?? '';
    await this.limiter.hit(bucket, hashToken(token).slice(0, 32), limit, 60);
    await this.limiter.hit('prop-ip', req.ip ?? 'inconnu', 600, 60);
  }

  @Public()
  @Get(':token')
  async view(@Param('token') token: string, @Headers('x-proposal-otp') otp: string | undefined, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.guard(req, res, 'prop-read', 120);
    return this.service.view(token, otp, new Date());
  }

  @Public()
  @Post(':token/events')
  @HttpCode(202)
  async events(@Param('token') token: string, @Body(new ZodPipe(ViewEventsSchema)) body: ViewEventsBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.guard(req, res, 'prop-events', 120);
    return this.service.track(token, body, req.ip, req.headers['user-agent'], new Date());
  }

  @Public()
  @Put(':token/selection')
  async selection(
    @Param('token') token: string,
    @Headers('x-proposal-otp') otp: string | undefined,
    @Body(new ZodPipe(SelectionSchema)) body: SelectionBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.guard(req, res, 'prop-write', 60);
    return this.service.select(token, otp, body, new Date());
  }

  @Public()
  @Post(':token/comments')
  async comment(
    @Param('token') token: string,
    @Headers('x-proposal-otp') otp: string | undefined,
    @Body(new ZodPipe(PublicCommentSchema)) body: { body: string; sectionKey?: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.guard(req, res, 'prop-write', 30);
    return this.service.comment(token, otp, body, new Date());
  }

  @Public()
  @Post(':token/decline')
  @HttpCode(200)
  async decline(
    @Param('token') token: string,
    @Headers('x-proposal-otp') otp: string | undefined,
    @Body(new ZodPipe(DeclineSchema)) body: { reasonCode: string; reason?: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.guard(req, res, 'prop-write', 30);
    return this.service.decline(token, otp, body, new Date());
  }

  @Public()
  @Post(':token/otp')
  @HttpCode(200)
  async otp(@Param('token') token: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.guard(req, res, 'prop-otp', 3);
    await this.limiter.hit('prop-otp-hour', hashToken(token).slice(0, 32), 10, 3600);
    return this.service.requestOtp(token, new Date());
  }

  @Public()
  @Post(':token/otp/verify')
  @HttpCode(200)
  async verifyOtp(@Param('token') token: string, @Body(new ZodPipe(OtpVerifySchema)) body: { code: string }, @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.guard(req, res, 'prop-otp-verify', 10);
    return this.service.verifyOtp(token, body.code, new Date());
  }

  @Public()
  @Post(':token/accept')
  @HttpCode(200)
  async accept(
    @Param('token') token: string,
    @Headers('x-proposal-otp') otp: string | undefined,
    @Body(new ZodPipe(AcceptSchema)) body: AcceptBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    await this.guard(req, res, 'prop-write', 10);
    return this.service.accept(token, otp, body, req.ip, req.headers['user-agent'], new Date());
  }

  @Public()
  @Get(':token/pdf')
  async pdf(@Param('token') token: string, @Headers('x-proposal-otp') otp: string | undefined, @Req() req: FastifyRequest, @Res() res: FastifyReply) {
    await this.guard(req, res, 'prop-pdf', 20);
    const file = await this.service.pdf(token, otp, new Date());
    sendFile(res, { body: file.pdf, contentType: 'application/pdf', filename: file.filename });
  }
}
