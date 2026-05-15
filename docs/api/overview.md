# 接口说明

DoneMail 公开 API 面向外部系统调用，接口统一挂载在 `/api` 下。

## 鉴权

公开 API 只接受 `X-Admin-Key` 鉴权，不使用后台登录 Cookie。

```http
X-Admin-Key: your-admin-key
```

| Header | 必填 | 说明 |
| --- | --- | --- |
| `X-Admin-Key` | 是 | 系统设置中的公开 API 密钥 |
| `Content-Type: application/json` | POST JSON 时必填 | 请求体为 JSON 时使用 |

## 成功返回

普通接口：

```json
{
  "ok": true,
  "data": {}
}
```

分页接口：

```json
{
  "ok": true,
  "data": [],
  "pagination": {
    "limit": 20,
    "nextCursor": "",
    "hasMore": false
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 请求是否成功 |
| `data` | any | 接口返回数据 |
| `pagination.limit` | number | 当前页数量限制 |
| `pagination.nextCursor` | string | 下一页游标，没有下一页时为空字符串 |
| `pagination.hasMore` | boolean | 是否还有下一页 |

附件下载接口成功时直接返回文件流，不返回 JSON。

## 失败返回

```json
{
  "ok": false,
  "error": {
    "code": "unauthorized",
    "message": "未授权"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 固定为 `false` |
| `error.code` | string | 错误码 |
| `error.message` | string | 错误说明 |

## 通用错误

| 状态码 | code | 说明 |
| --- | --- | --- |
| `401` | `unauthorized` | `X-Admin-Key` 缺失或错误 |
| `400` | `invalid_boolean` | 布尔查询参数必须使用 `true` 或 `false` |
| `503` | `schema_initializing` | 数据库正在初始化，请按 `Retry-After` 稍后重试 |
| `428` | `SETUP_REQUIRED` | 系统尚未初始化 |
| `429` | `rate_limited` | 鉴权失败请求过于频繁 |

鉴权失败会计入公开接口限流；鉴权成功不会写入限流计数。
