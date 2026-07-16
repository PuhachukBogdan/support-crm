import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// Sample slice — proves the Redux Toolkit store boots (R7). No product state yet.
interface SampleState {
  message: string;
}

const initialState: SampleState = { message: 'idle' };

const sampleSlice = createSlice({
  name: 'sample',
  initialState,
  reducers: {
    ping(state) {
      state.message = 'pinged';
    },
    setMessage(state, action: PayloadAction<string>) {
      state.message = action.payload;
    },
  },
});

export const { ping, setMessage } = sampleSlice.actions;
export const sampleReducer = sampleSlice.reducer;
