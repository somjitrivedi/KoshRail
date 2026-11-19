import { z } from 'zod';
import { RoleSchema } from '@kosh/contracts';
import { type Clock, createApp, type Db, type Logger, param, parse, requireCustomer, requireStaff, requireUser } from '@kosh/service-kit';
import { loadOrCreateSigningKey } from './crypto.ts';
import { DEFAULT_CONFIG, type IdentityConfig, IdentityService } from './service.ts';

const OtpRequest = z.object({ phone: z.string(), purpose: z.enum(['REGISTER', 'LOGIN']) });
const RegisterRequest = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  name: z.string().trim().min(2).max(80),
  deviceId: z.string().min(6).max(64),
  devicePublicKey: z.string().min(50).max(1000),
});
const LoginRequest = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().min(6).max(64),
  devicePublicKey: z.string().min(50).max(1000).optional(),
  deviceSignature: z.string().max(200).optional(),
});
const RefreshRequest = z.object({ refreshToken: z.string().min(10) });
const StaffLogin = z.object({ username: z.string().min(1), password: z.string().min(1) });
const CreateStaff = z.object({
  username: z.string().regex(/^[a-z0-9._-]{3,40}$/),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(10).max(128),
  role: RoleSchema,
  bankCode: z.string().nullable().default(null),
});
const SetMpin = z.object({ mpin: z.string(), currentMpin: z.string().optional() });
const VerifyMpin = z.object({ mpin: z.string(), purpose: z.string().min(1).max(40).default('PAYMENT') });
const VerifyMpinToken = z.object({ token: z.string().min(10) });

export interface IdentityDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  internalToken: string;
  config?: Partial<IdentityConfig>;
  adminPassword?: string;
}

export function buildIdentity(deps: IdentityDeps) {
  const key = loadOrCreateSigningKey(deps.db);
  const svc = new IdentityService(deps.db, deps.clock, key, { ...DEFAULT_CONFIG, ...deps.config });
  if (deps.adminPassword) svc.ensureBootstrapAdmin(deps.adminPassword);

  const app = createApp({ name: 'identity-service', internalToken: deps.internalToken, log: deps.log, publicPaths: ['/.well-known'] }, (r) => {
    r.get('/.well-known/jwks.json', (_req, res) => {
      res.json(svc.jwks());
    });

    r.post('/otp/request', (req, res) => {
      const body = parse(OtpRequest, req.body);
      res.status(201).json(svc.requestOtp(body.phone, body.purpose));
    });

    r.post('/register', (req, res) => {
      res.status(201).json(svc.register(parse(RegisterRequest, req.body)));
    });

    r.post('/login', (req, res) => {
      res.json(svc.login(parse(LoginRequest, req.body)));
    });

    r.post('/token/refresh', (req, res) => {
      res.json(svc.refresh(parse(RefreshRequest, req.body).refreshToken));
    });

    r.post('/logout', (req, res) => {
      res.json(svc.logout(parse(RefreshRequest, req.body).refreshToken));
    });

    r.post('/staff/login', (req, res) => {
      const body = parse(StaffLogin, req.body);
      res.json(svc.staffLogin(body.username, body.password));
    });

    r.post('/staff', (req, res) => {
      requireStaff(req, ['ADMIN']);
      res.status(201).json(svc.createStaff(parse(CreateStaff, req.body)));
    });

    r.get('/staff', (req, res) => {
      requireStaff(req, ['ADMIN']);
      res.json({ staff: svc.listStaff() });
    });

    r.get('/me', (req, res) => {
      res.json(svc.me(requireUser(req)));
    });

    r.get('/devices', (req, res) => {
      res.json({ devices: svc.listDevices(requireCustomer(req).sub) });
    });

    r.delete('/devices/:deviceId', (req, res) => {
      const p = requireCustomer(req);
      res.json(svc.revokeDevice(p.sub, param(req, 'deviceId'), p.deviceId));
    });

    r.put('/mpin', (req, res) => {
      const p = requireCustomer(req);
      const body = parse(SetMpin, req.body);
      res.json(svc.setMpin(p.sub, body.mpin, body.currentMpin));
    });

    r.post('/mpin/verify', (req, res) => {
      const p = requireCustomer(req);
      const body = parse(VerifyMpin, req.body);
      res.json(svc.verifyMpin(p.sub, body.mpin, body.purpose));
    });

    r.get('/internal/users/:id', (req, res) => {
      res.json(svc.getUser(param(req, 'id')));
    });

    r.post('/internal/mpin-tokens/verify', (req, res) => {
      res.json(svc.verifyMpinToken(parse(VerifyMpinToken, req.body).token));
    });
  });

  return { app, svc };
}
