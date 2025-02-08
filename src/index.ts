import { h, Context, Schema, Dict, Time, Random } from 'koishi'
import { config } from 'process'

export const name = 'group-manage'

interface BlockingRule {
  enable: boolean
  blockingWords: string[]
  mute: boolean
  muteDuration: number
  recall: boolean
  tip: boolean
}


export const Config = Schema.intersect([
  Schema.object({
    blockingRules: Schema.dict(Schema.object({
      enable: Schema.boolean().description('是否启用').default(true),
      blockingWords: Schema.array(String).description('违禁词列表 (可使用正则表达式)').default([]),
      mute: Schema.boolean().description('检测到违禁词后是否禁言').default(false),
      muteDuration: Schema.natural().role('ms').description('禁言时长 (单位为毫秒)').default(10 * Time.minute),
      recall: Schema.boolean().description('检测到违禁词后是否撤回').default(false),
      tip: Schema.boolean().description('是否在检测到违禁词后进行提示').default(true)
    }).description('群组平台与群组 ID, 格式:`platform:guildId`, 例如:`red:123456`')).description('规则列表'),
  }).description('违禁词检测设置'),
  Schema.object({
    isAdmin: Schema.boolean().default(true).description('指令是否需要该群的管理员权限'),
    banDuration: Schema.natural().role('ms').description('ban 和 ban-me 指令默认禁言时长 (单位为毫秒)').default(15 * Time.hour),
    autoUnban: Schema.boolean().default(false).description('是否自动解除自我禁言'),
  }).description('指令默认值设置'),
  Schema.union([
    Schema.object({
      autoUnban: Schema.const(true).required(),
      minTimeout: Schema.number().default(60000).description('自动解除自我禁言最少间隔时间'),
      maxTimeout: Schema.number().default(300000).description('自动解除自我禁言最多间隔时间'),
    }),
    Schema.object({})
  ])
])

export const usage: string = `
使用本插件对他人进行操作时，需要操作者的权限等级 (authority) 为 3 及以上。

权限设置教程: https://koishi.chat/zh-CN/manual/usage/customize.html#%E7%94%A8%E6%88%B7%E6%9D%83%E9%99%90
`

export function apply(ctx: Context, cfg) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))
  async function checkManage(session) {
    if (!session.guild) {
      return true
    }
    const info = await session.onebot.getGroupMemberInfo(session.guildId, session.userId)
    return info.role == 'admin' || info.role == 'owner'
  }
  ctx.middleware(async (session, next) => {
    if (session.gid in cfg.blockingRules) {
      const rule = cfg.blockingRules[session.gid]
      if (!rule.enable) return next()

      let hit = false
      for (const word of rule.blockingWords) {
        const re = new RegExp(word)
        const include = re.test(session.content)
        if (include) {
          hit = true
          break
        }
      }

      if (hit) {
        rule.tip && await session.send(session.text('group-manage.blocking-word.hit'))
        const { event } = session
        if (rule.recall) {
          try{
            await session.bot.deleteMessage(event.channel.id, event.message.id)
            rule.tip && await session.send(session.text('group-manage.blocking-word.recall'))
          }
          catch(e) {
            const pics = h.select(session.content, 'img')
            if (pics.length > 0) {
              session.execute('meme.generate.kiss ' + h.image(session.event.user.avatar) + pics[0])
            }
          }
        }
        if (rule.mute) {
          await session.bot.muteGuildMember(event.guild.id, event.user.id, rule.muteDuration)
          rule.tip && await session.send(session.text('group-manage.blocking-word.mute'))
        }
        return
      }
    }
    return next()
  })

  const command = ctx.command('group-manage')

  command.subcommand('ban <user:user> <duration:text>', { authority: 3 })
    .alias('mute', '禁言').userFields(['authority'])
    .action(async ({ session }, user, duration) => {
      if (session.user.authority == 3 && cfg.isAdmin && !(await checkManage(session)))
        return '权限不足'
      if (!user) return session.text('.missing-user')
      let time;
      if (!duration) {
        time = cfg.banDuration
      } else {
        time = parseDuration(duration)
        if (time === 0) return session.text('.missing-duration')
      }
      const userId = user.replace(session.platform + ':', '')
      await session.bot.muteGuildMember(session.guildId, userId, time)
      // return session.text('.executed')
    })

  command.subcommand('ban-me <duration:text>')
    .alias('self-ban', 'mute-me', '自我禁言')
    .action(async ({ session }, duration) => {
      let time
      if (!duration) {
        time = cfg.banDuration
      } else {
        time = parseDuration(duration)
        if (time === 0) return session.text('.missing-duration')
      }
      await session.bot.muteGuildMember(session.guildId, session.userId, time)
      if (time > cfg.maxTimeout) {
        ctx.setTimeout(() => {
          session.bot.muteGuildMember(session.guildId, session.userId, 0)
        }, Random.int(cfg.minTimeout, cfg.maxTimeout))
      }
      // return session.text('.executed')
    })

  command.subcommand('unban <user:user>', { authority: 3 })
    .alias('unmute', '取消禁言').userFields(['authority'])
    .action(async ({ session }, user) => {
      if (session.user.authority == 3 && cfg.isAdmin && !(await checkManage(session)))
        return '权限不足'
      if (!user) return session.text('.missing-user')
      const userId = user.replace(session.platform + ':', '')
      await session.bot.muteGuildMember(session.guildId, userId, 0)
      // return session.text('.executed')
    })

  command.subcommand('delmsg', { authority: 3 })
    .alias('撤回消息').userFields(['authority'])
    .action(async ({ session }) => {
      if (session.user.authority == 3 && cfg.isAdmin && !(await checkManage(session)))
        return '权限不足'
      if (!session.quote) return session.text('.missing-quote')
      await session.bot.deleteMessage(session.channelId, session.quote.id)
      // return session.text('.executed')
    })

  command.subcommand('mute-all', { authority: 3 })
    .alias('全员禁言').userFields(['authority'])
    .action(async ({ session }) => {
      if (session.user.authority == 3 && cfg.isAdmin && !(await checkManage(session)))
        return '权限不足'
      const { platform, guildId } = session
      switch (platform) {
        case 'red':
          await session.bot.internal.muteGroup({
            group: guildId,
            enable: true
          })
          break
        case 'onebot':
          await session.bot.internal.setGroupWholeBan(guildId, true)
          break
        case 'kritor':
          await session.bot.internal.setGroupWholeBan(guildId, true)
          break
        default:
          return session.text('.unsupported-platform')
      }
      // return session.text('.executed')
    })

  command.subcommand('unmute-all', { authority: 3 })
    .alias('取消全员禁言').userFields(['authority'])
    .action(async ({ session }) => {
      if (session.user.authority == 3 && cfg.isAdmin && !(await checkManage(session)))
        return '权限不足'
      const { platform, guildId } = session
      switch (platform) {
        case 'red':
          await session.bot.internal.muteGroup({
            group: guildId,
            enable: false
          })
          break
        case 'onebot':
          await session.bot.internal.setGroupWholeBan(guildId, false)
          break
        case 'kritor':
          await session.bot.internal.setGroupWholeBan(guildId, false)
          break
        default:
          return session.text('.unsupported-platform')
      }
      // return session.text('.executed')
    })
}

function parseDuration(duration: string): number | undefined {
  var time = 0
  const Reglist = [
    {
      'pattern': /(\d+)\s*[分|分钟|min|m]/gim,
      'unit': 60 * 1000
    },
    {
      'pattern': /(\d+)\s*[时|小时|hour|h]/gim,
      'unit': 60 * 60 * 1000
    },
    {
      'pattern': /(\d+)\s*[天|day|d]/gim,
      'unit': 24 * 60 * 60 * 1000
    }
  ]
  for (const reg of Reglist) {
    let match
    while (match = reg.pattern.exec(duration)) {
      // console.log(match)
      time += reg.unit * parseInt(match[1])
    }
  }
  time = Math.min(time, ((29 * 24 + 23) * 60 + 59) * 60 * 1000)
  // console.log(time)
  return time
}