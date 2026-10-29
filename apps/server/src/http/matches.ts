import type { FastifyInstance, FastifyRequest } from 'fastify';
import { acceptMatchSchema, invitationSchema, readyMatchSchema } from '@aquarium/protocol';
import type { MatchService } from '../services/matches';

interface Dependencies { app:FastifyInstance; auth:(request:FastifyRequest)=>string;key:(request:FastifyRequest)=>string;ok:(data:unknown,requestId:string)=>unknown;matches:MatchService }
export function registerMatchRoutes({app,auth,key,ok,matches}:Dependencies) {
  app.get('/api/v1/matches/history',async request=>ok(await matches.history(auth(request)),request.id));
  app.get<{Params:{id:string}}>('/api/v1/matches/:id',async request=>ok(await matches.view(auth(request),request.params.id),request.id));
  app.post('/api/v1/matches/invitations',async request=>ok(await matches.invite(auth(request),key(request),invitationSchema.parse(request.body)),request.id));
  app.post<{Params:{id:string}}>('/api/v1/matches/:id/accept',async request=>ok(await matches.accept(auth(request),key(request),request.params.id,acceptMatchSchema.parse(request.body??{})),request.id));
  app.post<{Params:{id:string}}>('/api/v1/matches/:id/ready',async request=>ok(await matches.ready(auth(request),key(request),request.params.id,readyMatchSchema.parse(request.body)),request.id));
  app.post<{Params:{id:string}}>('/api/v1/matches/:id/cancel',async request=>ok(await matches.cancel(auth(request),key(request),request.params.id),request.id));
}
