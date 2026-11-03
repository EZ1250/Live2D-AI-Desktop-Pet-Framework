package com.pet.mcpclient.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val PetColors = lightColorScheme(
    primary = Color(0xFF4A6CF7),
    onPrimary = Color.White,
    secondary = Color(0xFF6B7A99),
    surface = Color(0xFFFAFAFC),
    background = Color(0xFFF3F4F8),
    error = Color(0xFFD93025),
)

@Composable
fun PetMcpTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = PetColors, content = content)
}
