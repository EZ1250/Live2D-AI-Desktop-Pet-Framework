package com.pet.mcpclient.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * 头像帧解码器：三缓冲 + inBitmap 复用，避免 30fps 下每帧分配 ~2MB 造成 GC 抖动。
 *
 * 线程模型：decode() 在 ViewModel 的 Default 单协程里串行调用；reset() 只在 Main 线程、
 * 且通过 AppState 的 avatarDecoding 原子标志确保没有并发 decode 时调用。
 * 池状态用 synchronized 保护；displayed/prevDisplayed/decodingBuffer 不会被回收或复用，
 * 避免「Compose 还在画上一帧时 buffer 被复用/回收」导致花屏或 Cannot draw recycled bitmaps。
 */
class AvatarFrameDecoder {
    private var bufferA: Bitmap? = null
    private var bufferB: Bitmap? = null
    private var bufferC: Bitmap? = null
    private var displayed: Bitmap? = null
    private var prevDisplayed: Bitmap? = null
    private var decodingBuffer: Bitmap? = null
    private var slot = 0

    @Volatile
    var lastWidth: Int = 0
        private set

    @Volatile
    var lastHeight: Int = 0
        private set

    fun reset() {
        synchronized(this) {
            val keep = setOfNotNull(displayed, decodingBuffer)
            for (b in listOf(bufferA, bufferB, bufferC)) {
                if (b != null && b !in keep && !b.isRecycled) b.recycle()
            }
            bufferA = bufferA?.takeIf { it in keep }
            bufferB = bufferB?.takeIf { it in keep }
            bufferC = bufferC?.takeIf { it in keep }
            if (prevDisplayed != null && prevDisplayed !in keep && !prevDisplayed!!.isRecycled) {
                prevDisplayed!!.recycle()
            }
            prevDisplayed = null
            slot = 0
            lastWidth = 0
            lastHeight = 0
        }
    }

    fun decode(bytes: ByteArray): Bitmap? {
        if (bytes.isEmpty()) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val w = bounds.outWidth
        val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null

        val reuse = synchronized(this) {
            pickReusable(w, h).also { decodingBuffer = it }
        }
        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inMutable = true
            inBitmap = reuse
        }
        val decoded = try {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        } catch (e: IllegalArgumentException) {
            // inBitmap 尺寸/格式不匹配：退回普通解码
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
            })
        } catch (e: OutOfMemoryError) {
            null
        }
        synchronized(this) {
            decodingBuffer = null
            if (decoded != null) {
                if (decoded !== bufferA && decoded !== bufferB && decoded !== bufferC) {
                    when (slot % 3) {
                        0 -> bufferA = decoded
                        1 -> bufferB = decoded
                        else -> bufferC = decoded
                    }
                    slot += 1
                }
                prevDisplayed = displayed
                displayed = decoded
                lastWidth = decoded.width
                lastHeight = decoded.height
            }
        }
        return decoded
    }

    private fun pickReusable(width: Int, height: Int): Bitmap? {
        return listOf(bufferA, bufferB, bufferC)
            .filterNotNull()
            .filter {
                !it.isRecycled && it.width == width && it.height == height &&
                    it !== displayed && it !== prevDisplayed && it !== decodingBuffer
            }
            .firstOrNull()
    }
}
