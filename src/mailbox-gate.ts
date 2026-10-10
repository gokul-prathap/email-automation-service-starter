import type { Redis } from "ioredis";

const acquire = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
if redis.call('EXISTS',KEYS[1])==1 then
  local ttl=redis.call('PTTL',KEYS[1]); return math.max(ttl,tonumber(ARGV[3]))
end
local wait=tonumber(redis.call('GET',KEYS[2]) or '0')-now
if wait>0 then return wait end
redis.call('HSET',KEYS[1],'owner',ARGV[1],'phase','preparing')
redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 0`;
const begin = `
if redis.call('HGET',KEYS[1],'owner')~=ARGV[1] or redis.call('HGET',KEYS[1],'phase')~='preparing' then return 0 end
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('HSET',KEYS[1],'phase','submitting'); redis.call('PERSIST',KEYS[1])
redis.call('SET',KEYS[2],now+tonumber(ARGV[2])); return 1`;
const release = `
if redis.call('HGET',KEYS[1],'owner')~=ARGV[1] then return 0 end
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local next=math.max(tonumber(redis.call('GET',KEYS[2]) or '0'),now+tonumber(ARGV[2]))
redis.call('SET',KEYS[2],next); redis.call('DEL',KEYS[1]); return 1`;

export class MailboxGate {
  constructor(private redis: Redis, private interval: number, private lease: number,
    private prefix = "email-mailbox", private poll = 1000) {}
  keys(id: string) { return [`${this.prefix}:{${id}}:lock`, `${this.prefix}:{${id}}:next`]; }
  async acquire(id: string, owner: string) {
    return Number(await this.redis.eval(acquire, 2, ...this.keys(id), owner, this.lease, this.poll));
  }
  async begin(id: string, owner: string) {
    return Number(await this.redis.eval(begin, 2, ...this.keys(id), owner, this.interval)) === 1;
  }
  async release(id: string, owner: string, cooldown = 0) {
    return Number(await this.redis.eval(release, 2, ...this.keys(id), owner, Math.max(cooldown, this.interval))) === 1;
  }
  async inspect(id: string) { return this.redis.hgetall(this.keys(id)[0]); }
  async restoreQuarantine(id: string, owner: string) {
    await this.redis.eval(`if redis.call('EXISTS',KEYS[1])==0 then
      redis.call('HSET',KEYS[1],'owner',ARGV[1],'phase','uncertain'); return 1 end return 0`,
      1, this.keys(id)[0], owner);
  }
  async quarantine(id: string, owner: string) {
    await this.redis.eval(`if redis.call('HGET',KEYS[1],'owner')==ARGV[1] then
      redis.call('HSET',KEYS[1],'phase','uncertain'); redis.call('PERSIST',KEYS[1]); return 1 end return 0`,
    1, this.keys(id)[0], owner);
  }
}
