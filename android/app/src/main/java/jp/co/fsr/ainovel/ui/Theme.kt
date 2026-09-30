package jp.co.fsr.ainovel.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF3E5C76),
    secondary = Color(0xFF748CAB),
    tertiary = Color(0xFF1D2D44),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA9C6E0),
    secondary = Color(0xFF9DB2CE),
    tertiary = Color(0xFFC8D8E8),
)

@Composable
fun AINovelTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
