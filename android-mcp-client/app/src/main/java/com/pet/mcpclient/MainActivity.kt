package com.pet.mcpclient

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pet.mcpclient.ui.AppViewModel
import com.pet.mcpclient.ui.PetMcpApp
import com.pet.mcpclient.ui.PetMcpTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PetMcpTheme {
                PetMcpApp(viewModel<AppViewModel>())
            }
        }
    }
}
