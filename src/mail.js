/**
 * 邮件发送：通过 Resend API 发送验证码邮件（Workers 无法直连 SMTP）。
 *
 * 环境变量：
 *  - RESEND_API_KEY  Resend API 密钥（wrangler secret put RESEND_API_KEY）
 *  - MAIL_FROM       发件人，如 "云书签 <noreply@example.com>"；需在 Resend 验证对应域名
 *  - MAIL_DEV_MODE   设为 "true" 时跳过真实发送，把验证码直接随 API 返回（仅限本地调试！）
 */

import { ApiError } from './util.js';

export async function sendVerificationEmail(env, to, code, purpose) {
  const action = purpose === 'reset' ? '找回密码' : '注册';
  if (env.MAIL_DEV_MODE === 'true') {
    console.log(`[MAIL_DEV_MODE] ${action}验证码 -> ${to}: ${code}`);
    return { dev: true };
  }
  if (!env.RESEND_API_KEY) {
    throw new ApiError(
      '邮件服务未配置：请设置环境变量 RESEND_API_KEY 与 MAIL_FROM（见 README「邮件服务配置」）；本地调试可设 MAIL_DEV_MODE=true',
      500,
    );
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || '云书签 <onboarding@resend.dev>',
      to: [to],
      subject: `【云书签】${action}验证码 ${code}`,
      html: buildCodeHtml(code, action),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error('邮件发送失败:', res.status, detail);
    throw new ApiError('验证码邮件发送失败，请稍后重试', 502);
  }
  return { dev: false };
}

function buildCodeHtml(code, action) {
  // 模板为静态内容，仅插入我们自己生成的 4 位数字验证码
  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f3f5fb;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
    <div style="max-width:420px;margin:32px auto;background:#ffffff;border:1px solid #e3e8f2;border-radius:16px;padding:32px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:#1c2230;">🔖 云书签</div>
      <p style="margin:20px 0 8px;color:#5b6472;font-size:14px;">你正在进行<strong>${action}</strong>操作，验证码为：</p>
      <div style="font-size:36px;font-weight:700;letter-spacing:12px;color:#4f6ef7;padding:16px 0;font-family:Consolas,monospace;">${code}</div>
      <p style="margin:0;color:#8a93a3;font-size:13px;">验证码 10 分钟内有效，请勿泄露给他人。<br/>如非本人操作，请忽略本邮件。</p>
    </div>
  </body>
</html>`;
}
